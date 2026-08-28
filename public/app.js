// AWS Migration Console — client for the ACP bridge.
// The frontend is just the face of the aws-migration-orchestrator agent.
// It sends a natural-language message and streams back the agent's narration
// and tool calls, mapping tool calls to the visual pipeline stages.

const state = { sessionId: null };
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');

// Map orchestrator tool names → visual pipeline stages
const TOOL_STAGE = {
  scan_region: 'discovery',
  list_resources: 'discovery',
  build_graph: 'graph',
  get_architecture: 'graph',
  analyze_resource_migration: 'assessment',
  get_migration_rule: 'assessment',
  generate_migration_manifest: 'cfn',
  generate_faithful_cfn: 'cfn',
  adapt_template_for_target: 'cfn',
};

function setStage(name, status) {
  const el = document.querySelector(`.stage[data-stage="${name}"]`);
  if (el) el.className = `stage ${status}`;
}

function appendNarration(text) {
  const log = $('narration');
  log.textContent += text;
  log.scrollTop = log.scrollHeight;
}

function appendToolCall(name, status) {
  const stage = TOOL_STAGE[name];
  if (stage) setStage(stage, status === 'completed' || status === 'success' ? 'done' : 'active');
  // Also log execution-phase shell commands (aws cloudformation deploy, create-image…)
  if (name && name.toLowerCase().includes('cloudformation')) setStage('cfn', 'done');
  const log = $('toolcalls');
  log.textContent += `⚙ ${name} — ${status}\n`;
  log.scrollTop = log.scrollHeight;
}

// ── Send a message to the orchestrator ──────────────────────────────────────
async function sendMessage(message) {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, message }),
  });
  const data = await resp.json();
  state.sessionId = data.sessionId;

  // Open SSE stream for this session (idempotent — same session reuses)
  if (!state._streaming) openStream();
}

function openStream() {
  state._streaming = true;
  const es = new EventSource(`/api/chat/${state.sessionId}/stream`);
  es.onmessage = (ev) => {
    const evt = JSON.parse(ev.data);
    switch (evt.type) {
      case 'message': appendNarration(evt.text || ''); break;
      case 'tool_call': appendToolCall(evt.toolName, evt.toolStatus); break;
      case 'tool_update': appendToolCall(evt.toolName, evt.toolStatus); break;
      case 'turn_end':
        appendNarration('\n\n— (aguardando você) —\n');
        $('btn-send').disabled = false;
        break;
      case 'error': appendNarration(`\n[erro] ${evt.text}\n`); break;
    }
  };
  es.onerror = () => { es.close(); state._streaming = false; };
}

// ── UI wiring ────────────────────────────────────────────────────────────────
$('btn-start').onclick = () => {
  const src = $('src-region').value.trim();
  const tgt = $('tgt-region').value.trim();
  const acct = $('tgt-account').value.trim();
  const crossAccount = acct ? ` para a conta ${acct}` : '';
  const msg = `Migre a aplicação do cluster que eu selecionar de ${src} para ${tgt}${crossAccount}. `
    + `Rode discovery, graph, assessment, gere o CloudFormation fiel e me mostre o plano antes de executar.`;
  show('pipeline-panel');
  setStage('discovery', 'active');
  $('btn-send').disabled = true;
  $('composer').value = msg;
  sendMessage(msg);
};

$('btn-send').onclick = () => {
  const msg = $('composer').value.trim();
  if (!msg) return;
  appendNarration(`\n\n> ${msg}\n`);
  $('btn-send').disabled = true;
  sendMessage(msg);
  $('composer').value = '';
};

$('btn-approve').onclick = () => {
  appendNarration('\n\n> Pode executar a migração.\n');
  sendMessage('Pode executar a migração.');
};

$('btn-cancel').onclick = () => {
  if (state.sessionId) fetch(`/api/chat/${state.sessionId}/cancel`, { method: 'POST' });
};
