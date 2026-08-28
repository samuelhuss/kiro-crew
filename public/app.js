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
  $('narration').innerHTML = '<span class="cursor"></span>';
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

// smooth typewriter: buffer incoming chunks, drain at a steady rate
const typer = { buf: '', el: null, timer: null };
function typeInto(text) {
  if (!typer.el) typer.el = $('narration');
  typer.buf += text;
  if (!typer.timer) drain();
}
function drain() {
  if (!typer.buf.length) { typer.timer = null; return; }
  const n = Math.max(2, Math.ceil(typer.buf.length / 60)); // catch up if far behind
  const chunk = typer.buf.slice(0, n);
  typer.buf = typer.buf.slice(n);
  const cursor = typer.el.querySelector('.cursor');
  const node = document.createTextNode(chunk);
  if (cursor) typer.el.insertBefore(node, cursor); else typer.el.appendChild(node);
  const body = typer.el.closest('.body'); if (body) body.scrollTop = body.scrollHeight;
  typer.timer = setTimeout(drain, 16);
}
function narrateRaw(text) { // instant (user lines)
  const cursor = $('narration').querySelector('.cursor');
  const div = document.createElement('div');
  div.className = 'userline'; div.textContent = text;
  if (cursor) $('narration').insertBefore(div, cursor); else $('narration').appendChild(div);
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
  narrateRaw('› ' + msg);
  $('composer').value = ''; $('btn-send').disabled = true;
  $('approval').classList.remove('show');
  startChat(msg, false);
};
$('composer').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('btn-send').disabled) $('btn-send').click(); });

$('btn-approve').onclick = () => {
  narrateRaw('› Pode executar a migração.');
  $('approval').classList.remove('show');
  STAGE_ORDER.forEach((s) => setStage(s, 'done'));
  startChat('Pode executar a migração, siga fase por fase.', false);
};

loadCreds();
