// AWS Migration Console — client for the ACP bridge.
// The frontend is the visual face of the aws-migration-orchestrator agent:
// it collects credentials, sends a migration request, and streams the agent's
// narration + tool calls, mapping them to a visual pipeline. No migration logic.

const $ = (id) => document.getElementById(id);
const state = { sessionId: null, acct: 'source', creds: { source: null, target: null }, streaming: false };

// ── Step navigation ──────────────────────────────────────────────────────────
function goStep(n) {
  // steps 1-2 use the centered cards; step 3 is the full chat view
  $('card-creds').classList.toggle('hidden', n !== 1);
  $('card-params').classList.toggle('hidden', n !== 2);
  $('center-wrap').classList.toggle('hidden', n === 3);
  $('view-exec').classList.toggle('show', n === 3);
  $('stepper').classList.toggle('hidden', n === 3);
  $('hdr-status').style.visibility = n === 3 ? 'visible' : 'hidden';
  document.querySelectorAll('.step-pill').forEach((p) => {
    const s = Number(p.dataset.step);
    p.classList.toggle('active', s === n);
    p.classList.toggle('done', s < n);
  });
}

// ── STEP 1: credentials ───────────────────────────────────────────────────────
document.querySelectorAll('#acct-seg button').forEach((b) => {
  b.onclick = () => {
    // stash current inputs into the active account slot
    stashCreds();
    state.acct = b.dataset.acct;
    document.querySelectorAll('#acct-seg button').forEach((x) => x.classList.toggle('on', x === b));
    loadCreds();
  };
});
function stashCreds() {
  state.creds[state.acct] = {
    accessKeyId: $('ak').value.trim(), secretAccessKey: $('sk').value.trim(),
    sessionToken: $('st').value.trim(), region: $('rg').value.trim(),
  };
}
function loadCreds() {
  const c = state.creds[state.acct] || { accessKeyId: '', secretAccessKey: '', sessionToken: '', region: 'us-east-1' };
  $('ak').value = c.accessKeyId; $('sk').value = c.secretAccessKey;
  $('st').value = c.sessionToken; $('rg').value = c.region;
}

$('btn-save-creds').onclick = async () => {
  stashCreds();
  const src = state.creds.source;
  const tgt = state.creds.target;
  const status = $('creds-status');
  if (!src || !src.accessKeyId) {
    showStatus(status, 'Preencha as credenciais da conta origem.', true);
    return;
  }
  const payload = { source: src };
  const hasTarget = tgt && (tgt.accessKeyId || tgt.secretAccessKey);
  if (hasTarget) payload.target = tgt;
  $('btn-save-creds').disabled = true;
  try {
    const resp = await fetch('/api/creds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) { showStatus(status, data.error || 'Falha ao salvar.', true); $('btn-save-creds').disabled = false; return; }
    let msg = `Origem gravada em ${data.serversUpdated.length} MCPs · região ${data.region} · key …${data.accessKeyIdTail}`;
    if (data.target) msg += ` · destino: região ${data.target.region} · key …${data.target.accessKeyIdTail} (cross-account)`;
    showStatus(status, msg, false);
    $('src-region').value = src.region;
    if (data.target) $('tgt-region').value = data.target.region;
    setTimeout(() => { goStep(2); $('btn-save-creds').disabled = false; }, 800);
  } catch (e) {
    showStatus(status, 'Erro de rede: ' + e.message, true);
    $('btn-save-creds').disabled = false;
  }
};
function showStatus(el, msg, isErr) {
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
}

// ── STEP 2: params ────────────────────────────────────────────────────────────
$('btn-back-1').onclick = () => goStep(1);
$('btn-start').onclick = () => {
  const src = $('src-region').value.trim();
  const tgt = $('tgt-region').value.trim();
  const acct = $('tgt-account').value.trim();
  const extra = $('extra').value.trim();
  $('r-src').textContent = src; $('r-tgt').textContent = tgt;
  const cross = acct ? ` para a conta ${acct}` : '';
  const extraTxt = extra ? ` ${extra}.` : '';
  const msg = `Migre a aplicação de ${src} para ${tgt}${cross}.${extraTxt} `
    + `Rode discovery, grafo, assessment e gere o CloudFormation fiel automaticamente, `
    + `e me mostre o plano completo antes de executar.`;
  goStep(3);
  setStage('discovery', 'active');
  chatEl().innerHTML = '<div class="empty-hint">Aguardando o orquestrador…</div>';
  mcpSet.clear(); markMcpReady(); updateContext(0);
  $('mcp-chip').classList.remove('ready');
  startChat(msg, true);
};

// ── STEP 3: pipeline / streaming ──────────────────────────────────────────────
const TOOL_STAGE = {
  scan_region: 'discovery', list_resources: 'discovery',
  build_graph: 'graph', get_architecture: 'graph', get_dependencies: 'graph',
  analyze_resource_migration: 'assessment', get_migration_rule: 'assessment',
  generate_migration_manifest: 'cfn', generate_faithful_cfn: 'cfn', adapt_template_for_target: 'cfn',
};
const STAGE_ORDER = ['discovery', 'graph', 'assessment', 'cfn'];

function setStage(name, status) {
  const el = document.querySelector(`.pchip[data-stage="${name}"]`);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (status) el.classList.add(status);
}
function advanceStage(name) {
  // mark this stage active, and everything before it done
  const idx = STAGE_ORDER.indexOf(name);
  if (idx < 0) return;
  STAGE_ORDER.forEach((s, i) => {
    if (i < idx) setStage(s, 'done');
    else if (i === idx) { const el = document.querySelector(`.pchip[data-stage="${s}"]`); if (el && !el.classList.contains('done')) setStage(s, 'active'); }
  });
}

// ── Chat rendering (multi-bubble + artifact cards) ───────────────────────────
const chat = { buf: '', turnRaw: '', turnEl: null, curStage: null, timer: null };

function chatEl() { return $('chat'); }
function clearHint() { const h = chatEl().querySelector('.empty-hint'); if (h) h.remove(); }
function scrollChat() { const b = document.querySelector('.stream'); if (b) b.scrollTop = b.scrollHeight; }

const STAGE_LABEL = { discovery: 'Discovery', graph: 'Grafo', assessment: 'Assessment', cfn: 'CloudFormation' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Minimal, safe inline+block markdown for a PROSE segment (no fenced code). */
function mdProse(src) {
  let html = esc(src);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/(?:^[-*]\s+.+(?:\n|$))+/gm, (m) =>
    '<ul>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('') + '</ul>');
  html = html.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm, (m) =>
    '<ol>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('') + '</ol>');
  html = html.split(/\n{2,}/).map((c) => {
    if (/^\s*<(h3|ul|ol)/.test(c)) return c;
    return c.trim() ? `<p>${c.replace(/\n/g, '<br>')}</p>` : '';
  }).join('');
  return html;
}

/** Classify a fenced code block into an artifact descriptor. */
function classifyArtifact(lang, code) {
  const l = (lang || '').toLowerCase();
  const head = code.slice(0, 400);
  if (l === 'yaml' || l === 'yml' || /AWSTemplateFormatVersion|Resources:\s*\n/.test(head)) {
    const type = /AWSTemplateFormatVersion|Type:\s*AWS::/.test(head) ? 'CloudFormation' : 'YAML';
    return { icon: '⌘', title: type + ' template', kind: 'cfn' };
  }
  if (l === 'json' || /^\s*[{[]/.test(head)) return { icon: '{}', title: 'JSON', kind: 'json' };
  if (l === 'md' || l === 'markdown' || /^#\s|Migration Manifest/i.test(head)) return { icon: '☰', title: 'Manifest', kind: 'manifest' };
  return { icon: '›', title: (lang || 'código'), kind: 'code' };
}

/**
 * Parse the current turn's raw text into ordered segments:
 *   { t:'prose', text } | { t:'artifact', lang, code }
 * Fenced code blocks become artifacts; a trailing UNCLOSED fence is a
 * still-streaming artifact.
 */
function parseSegments(raw) {
  const segs = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) segs.push({ t: 'prose', text: raw.slice(last, m.index) });
    segs.push({ t: 'artifact', lang: m[1], code: m[2].replace(/\n$/, ''), streaming: false });
    last = re.lastIndex;
  }
  const tail = raw.slice(last);
  const openFence = tail.match(/```(\w*)\n?([\s\S]*)$/);
  if (openFence) {
    if (openFence.index > 0) segs.push({ t: 'prose', text: tail.slice(0, openFence.index) });
    segs.push({ t: 'artifact', lang: openFence[1], code: openFence[2], streaming: true });
  } else if (tail.length) {
    segs.push({ t: 'prose', text: tail });
  }
  return segs;
}

/** Build the DOM for one agent turn: one message, prose + artifact cards inside .body. */
function renderTurn(container, raw, showCursor) {
  const segs = parseSegments(raw);
  let inner = '';
  segs.forEach((s) => {
    if (s.t === 'prose') {
      const h = mdProse(s.text);
      if (h.trim()) inner += h;
    } else {
      const a = classifyArtifact(s.lang, s.code);
      const lines = s.code.split('\n').length;
      const bytes = new Blob([s.code]).size;
      const openCls = s.streaming ? ' open' : '';
      inner += `<div class="artifact${openCls}" data-code="${encodeURIComponent(s.code)}">`
        + `<div class="a-head"><div class="a-ic">${a.icon}</div>`
        + `<div class="a-meta"><div class="a-title">${esc(a.title)}</div>`
        + `<div class="a-sub">${lines} linhas · ${(bytes / 1024).toFixed(1)} KB${s.streaming ? ' · gerando…' : ''}</div></div>`
        + `<button class="a-btn a-copy">copiar</button><span class="a-chevron">▶</span></div>`
        + `<div class="a-body"><pre>${esc(s.code)}</pre></div></div>`;
    }
  });
  if (showCursor) inner += '<span class="cursor"></span>';
  container.innerHTML = `<div class="msg agent"><div class="avatar">c</div><div class="body">${inner}</div></div>`;
}

function startTurn() {
  clearHint();
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  chatEl().appendChild(wrap);
  chat.turnEl = wrap;
  chat.turnRaw = '';
}
function finishTurn() {
  if (chat.turnEl) { renderTurn(chat.turnEl, chat.turnRaw, false); wireArtifacts(chat.turnEl); chat.turnEl = null; }
}

function addUserBubble(text) {
  clearHint();
  finishTurn();
  const msg = document.createElement('div');
  msg.className = 'msg user';
  msg.innerHTML = `<div class="avatar">▲</div><div class="body"></div>`;
  msg.querySelector('.body').textContent = text;
  chatEl().appendChild(msg);
  scrollChat();
}

// collapse/expand + copy on artifact cards
function wireArtifacts(root) {
  root.querySelectorAll('.artifact').forEach((art) => {
    if (art.dataset.wired) return; art.dataset.wired = '1';
    art.querySelector('.a-head').addEventListener('click', (e) => {
      if (e.target.classList.contains('a-copy')) return;
      art.classList.toggle('open');
    });
    const copy = art.querySelector('.a-copy');
    if (copy) copy.addEventListener('click', () => {
      navigator.clipboard.writeText(decodeURIComponent(art.dataset.code || '')).then(() => {
        copy.textContent = 'copiado ✓'; setTimeout(() => (copy.textContent = 'copiar'), 1500);
      });
    });
  });
}

// smooth streaming: buffer chunks, drain steadily, re-render the current turn
function typeInto(text) {
  chat.buf += text;
  if (!chat.timer) drain();
}
function drain() {
  if (!chat.buf.length) { chat.timer = null; return; }
  if (!chat.turnEl) startTurn();
  const n = Math.max(3, Math.ceil(chat.buf.length / 50));
  chat.turnRaw += chat.buf.slice(0, n);
  chat.buf = chat.buf.slice(n);
  renderTurn(chat.turnEl, chat.turnRaw, true);
  wireArtifacts(chat.turnEl);
  scrollChat();
  chat.timer = setTimeout(drain, 18);
}

function esc2(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderTool(evt) {
  const name = evt.toolName || 'tool';
  const status = evt.toolStatus || '';
  const done = /complet|success|done|finish/i.test(status);
  const failed = /fail|error|denied|reject/i.test(status);
  const stage = TOOL_STAGE[name] || (name && name.toLowerCase().includes('cloudformation') ? 'cfn' : null);
  if (stage) { chat.curStage = stage; if (done) setStage(stage, 'done'); else advanceStage(stage); }

  clearHint();
  const key = 'tool-' + (evt.toolId || name).replace(/[^\w]/g, '');
  const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let el = chatEl().querySelector(`[data-k="${key}"]`);
  if (!el) {
    // a tool call interrupts the current agent turn — freeze it so the tool
    // appears inline after the text that preceded it, then a new bubble follows.
    finishTurn();
    el = document.createElement('div');
    el.className = 'tool'; el.dataset.k = key; el.dataset.t0 = now;
    el.innerHTML =
      `<div class="t-head"><span class="t-ic"><span class="spin"></span></span>`
      + `<span class="t-cmd"></span><span class="t-time"></span><span class="t-chev">▶</span></div>`
      + `<div class="t-body"></div>`;
    el.querySelector('.t-head').addEventListener('click', () => el.classList.toggle('open'));
    chatEl().appendChild(el);
  }

  // header: tool name + command preview
  const cmd = evt.toolInput || '';
  const cmdEl = el.querySelector('.t-cmd');
  cmdEl.innerHTML = `<span class="n">${esc2(name)}</span>` + (cmd ? ` ${esc2(cmd)}` : '');
  cmdEl.title = cmd ? `${name}  ${cmd}` : name;

  // status → icon + color
  el.classList.toggle('failed', failed);
  const ic = el.querySelector('.t-ic');
  if (failed) ic.innerHTML = '<span style="color:var(--err)">✗</span>';
  else if (done) ic.innerHTML = '<span class="check">✓</span>';
  el.querySelector('.t-time').textContent = (done || failed) ? `${status} · ${now}` : (el.dataset.t0 || now);

  // body: input (always) + output (when present)
  const body = el.querySelector('.t-body');
  let html = '';
  if (cmd) html += `<div class="t-io"><span class="lbl">comando</span>${esc2(cmd)}</div>`;
  if (evt.toolOutput) html += `<div class="t-io out"><span class="lbl">resultado</span>${esc2(evt.toolOutput)}</div>`;
  body.innerHTML = html;
  if (failed) el.classList.add('open');

  scrollChat();
}

async function startChat(message, isFirst) {
  const resp = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, message }),
  });
  const data = await resp.json();
  const firstEver = !state.sessionId;
  state.sessionId = data.sessionId;
  if (firstEver) openStream();
}

function openStream() {
  if (state.streaming) return;
  state.streaming = true;
  const es = new EventSource(`/api/chat/${state.sessionId}/stream`);
  es.onmessage = (ev) => {
    const evt = JSON.parse(ev.data);
    switch (evt.type) {
      case 'message': typeInto(evt.text || ''); break;
      case 'tool_call':
      case 'tool_update': renderTool(evt); break;
      case 'context': updateContext(evt.contextPct); break;
      case 'mcp': markMcpReady(evt.mcpServer); break;
      case 'turn_end':
        finishTurn();
        if (evt.stopReason && evt.stopReason !== 'end_turn') {
          typeInto(`\n_(turno encerrado: ${evt.stopReason})_\n`);
        }
        $('approval').classList.add('show');
        $('btn-send').disabled = false;
        break;
      case 'error': typeInto(`\n[erro] ${evt.text}\n`); break;
    }
  };
  es.onerror = () => { es.close(); state.streaming = false; };
}

// context usage bar
function updateContext(pct) {
  if (typeof pct !== 'number') return;
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = $('ctx-fill'); const label = $('ctx-pct');
  if (fill) fill.style.width = p + '%';
  if (label) label.textContent = p + '%';
}

// MCP readiness chip
const mcpSet = new Set();
function markMcpReady(name) {
  if (name) mcpSet.add(name);
  const chip = $('mcp-chip'); const count = $('mcp-count');
  if (count) count.textContent = `MCPs ${mcpSet.size}/6`;
  if (chip && mcpSet.size >= 6) chip.classList.add('ready');
}

$('btn-send').onclick = () => {
  const msg = $('composer').value.trim(); if (!msg) return;
  addUserBubble(msg);
  $('composer').value = ''; $('btn-send').disabled = true;
  $('approval').classList.remove('show');
  startChat(msg, false);
};
$('composer').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('btn-send').disabled) $('btn-send').click(); });

$('btn-approve').onclick = () => {
  addUserBubble('Pode executar a migração.');
  $('approval').classList.remove('show');
  STAGE_ORDER.forEach((s) => setStage(s, 'done'));
  startChat('Pode executar a migração, siga fase por fase.', false);
};

loadCreds();
