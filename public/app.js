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
  const status = $('creds-status');
  if (!src || !src.accessKeyId) {
    showStatus(status, 'Preencha as credenciais da conta origem.', true);
    return;
  }
  $('btn-save-creds').disabled = true;
  try {
    const resp = await fetch('/api/creds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(src),
    });
    const data = await resp.json();
    if (!resp.ok) { showStatus(status, data.error || 'Falha ao salvar.', true); $('btn-save-creds').disabled = false; return; }
    showStatus(status, `Gravado em ${data.serversUpdated.length} MCPs · região ${data.region} · key …${data.accessKeyIdTail}`, false);
    $('src-region').value = src.region;
    setTimeout(() => { goStep(2); $('btn-save-creds').disabled = false; }, 700);
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

// ── Chat rendering (message bubbles + minimal markdown) ───────────────────────
const chat = { buf: '', agentRaw: '', agentBubble: null, timer: null };

function chatEl() { return $('chat'); }
function clearHint() { const h = chatEl().querySelector('.empty-hint'); if (h) h.remove(); }

/** Minimal, safe markdown → HTML (escapes first, then applies a small subset). */
function mdToHtml(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // extract fenced code blocks first
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  let html = esc(src);
  // inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // bold / italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // headings
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<h3>$1</h3>');
  // bullet / numbered lists
  html = html.replace(/(?:^[-*]\s+.+(?:\n|$))+/gm, (m) => {
    const items = m.trim().split('\n').map((l) => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  html = html.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm, (m) => {
    const items = m.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });
  // paragraphs from remaining double-newline blocks
  html = html.split(/\n{2,}/).map((chunk) => {
    if (/^\s*<(h3|ul|ol|pre)/.test(chunk)) return chunk;
    return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  // restore code blocks
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return html;
}

function newAgentBubble() {
  clearHint();
  const msg = document.createElement('div');
  msg.className = 'msg agent';
  msg.innerHTML = `<div class="avatar">c</div><div class="bubble"><span class="cursor"></span></div>`;
  chatEl().appendChild(msg);
  chat.agentBubble = msg.querySelector('.bubble');
  chat.agentRaw = '';
  scrollChat();
}

function addUserBubble(text) {
  clearHint();
  finishAgentBubble(); // close any open agent bubble first
  const msg = document.createElement('div');
  msg.className = 'msg user';
  msg.innerHTML = `<div class="avatar">▲</div><div class="bubble"></div>`;
  msg.querySelector('.bubble').textContent = text;
  chatEl().appendChild(msg);
  scrollChat();
}

function finishAgentBubble() {
  if (chat.agentBubble) {
    chat.agentBubble.innerHTML = mdToHtml(chat.agentRaw);
    chat.agentBubble = null;
  }
}

function scrollChat() {
  const body = chatEl().closest('.body');
  if (body) body.scrollTop = body.scrollHeight;
}

// smooth streaming: buffer chunks, drain steadily, re-render current bubble as markdown
function typeInto(text) {
  chat.buf += text;
  if (!chat.timer) drain();
}
function drain() {
  if (!chat.buf.length) { chat.timer = null; return; }
  if (!chat.agentBubble) newAgentBubble();
  const n = Math.max(3, Math.ceil(chat.buf.length / 50));
  chat.agentRaw += chat.buf.slice(0, n);
  chat.buf = chat.buf.slice(n);
  // render markdown live, keep a cursor at the end
  chat.agentBubble.innerHTML = mdToHtml(chat.agentRaw) + '<span class="cursor"></span>';
  scrollChat();
  chat.timer = setTimeout(drain, 18);
}

function addToolCall(name, status) {
  const stage = TOOL_STAGE[name] || (name && name.toLowerCase().includes('cloudformation') ? 'cfn' : null);
  const done = /complet|success|done|finish/i.test(status);
  if (stage) { if (done) setStage(stage, 'done'); else advanceStage(stage); }

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
        finishAgentBubble();
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
