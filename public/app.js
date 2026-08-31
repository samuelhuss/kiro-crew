// AWS Migration Console — client for the ACP bridge.
// The frontend is the visual face of the aws-migration-orchestrator agent:
// it collects credentials, sends a migration request, and streams the agent's
// narration + tool calls, mapping them to a visual pipeline. No migration logic.

const $ = (id) => document.getElementById(id);
const state = { sessionId: null, acct: 'source', creds: { source: null, target: null }, streaming: false };

// ── Step navigation ──────────────────────────────────────────────────────────
function goStep(n) {
  ['creds', 'params', 'exec'].forEach((k, i) => {
    $('card-' + k).classList.toggle('hidden', i !== n - 1);
  });
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
  const el = document.querySelector(`.stage[data-stage="${name}"]`);
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
    else if (i === idx) { const el = document.querySelector(`.stage[data-stage="${s}"]`); if (!el.classList.contains('done')) setStage(s, 'active'); }
  });
}

// ── Chat rendering (multi-bubble + artifact cards) ───────────────────────────
const chat = { buf: '', turnRaw: '', turnEl: null, curStage: null, timer: null };

function chatEl() { return $('chat'); }
function clearHint() { const h = chatEl().querySelector('.empty-hint'); if (h) h.remove(); }
function scrollChat() { const b = chatEl().closest('.body'); if (b) b.scrollTop = b.scrollHeight; }

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

/** Build the DOM for one agent turn from its raw text (multiple bubbles + cards). */
function renderTurn(container, raw, showCursor) {
  const segs = parseSegments(raw);
  let html = '';
  let bubbleOpen = false;
  const badge = () => (chat.curStage ? `<span class="step-badge"><span class="b-dot"></span>${STAGE_LABEL[chat.curStage] || ''}</span>` : '');
  const openBubble = () => { if (!bubbleOpen) { html += `<div class="msg agent"><div class="avatar">c</div><div class="col">${badge()}`; bubbleOpen = true; } };
  const closeBubble = () => { if (bubbleOpen) { html += '</div></div>'; bubbleOpen = false; } };

  segs.forEach((s) => {
    if (s.t === 'prose') {
      const inner = mdProse(s.text);
      if (!inner.trim()) return;
      openBubble();
      html += `<div class="bubble">${inner}</div>`;
    } else {
      closeBubble();
      const a = classifyArtifact(s.lang, s.code);
      const lines = s.code.split('\n').length;
      const bytes = new Blob([s.code]).size;
      const openCls = s.streaming ? ' open' : '';
      html += `<div class="msg agent"><div class="avatar">c</div><div class="col" style="width:100%">`
        + `<div class="artifact${openCls}" data-code="${encodeURIComponent(s.code)}">`
        + `<div class="a-head"><div class="a-ic">${a.icon}</div>`
        + `<div class="a-meta"><div class="a-title">${esc(a.title)}</div>`
        + `<div class="a-sub">${lines} linhas · ${(bytes / 1024).toFixed(1)} KB${s.streaming ? ' · gerando…' : ''}</div></div>`
        + `<div class="a-actions"><button class="a-btn a-copy">copiar</button><span class="a-chevron">▶</span></div></div>`
        + `<div class="a-body"><pre>${esc(s.code)}</pre></div></div></div></div>`;
    }
  });
  closeBubble();
  container.innerHTML = html;
  if (showCursor) {
    const bubbles = container.querySelectorAll('.msg.agent .bubble');
    const lastB = bubbles[bubbles.length - 1];
    if (lastB) lastB.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
  }
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
  msg.innerHTML = `<div class="avatar">▲</div><div class="bubble"></div>`;
  msg.querySelector('.bubble').textContent = text;
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

function addToolCall(name, status) {
  const stage = TOOL_STAGE[name] || (name && name.toLowerCase().includes('cloudformation') ? 'cfn' : null);
  const done = /complet|success|done|finish/i.test(status);
  if (stage) { chat.curStage = stage; if (done) setStage(stage, 'done'); else advanceStage(stage); }

  const log = $('toolcalls');
  const key = 'tc-' + name.replace(/[^\w]/g, '');
  let row = log.querySelector(`[data-k="${key}"]`);
  if (!row) {
    row = document.createElement('div'); row.className = 'toolrow'; row.dataset.k = key;
    row.innerHTML = `<span class="ic"><span class="spin"></span></span><span class="tn"></span><span class="ts"></span>`;
    row.querySelector('.tn').textContent = name;
    log.appendChild(row);
  }
  row.querySelector('.ts').textContent = status;
  if (done) row.querySelector('.ic').innerHTML = '<span class="check">✓</span>';
  log.scrollTop = log.scrollHeight;
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
      case 'tool_update': addToolCall(evt.toolName || 'tool', evt.toolStatus || ''); break;
      case 'turn_end':
        finishTurn();
        $('approval').classList.add('show');
        $('btn-send').disabled = false;
        break;
      case 'error': typeInto(`\n[erro] ${evt.text}\n`); break;
    }
  };
  es.onerror = () => { es.close(); state.streaming = false; };
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
