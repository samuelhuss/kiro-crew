// AWS Migration Console — client logic (vanilla JS, no dependencies).
// Talks to the node:http API served from the same origin (127.0.0.1:PORT).

const state = {
  sessionId: null,
  planId: null,
  executionId: null,
  clusters: [],
  selectedResourceIds: [],
};

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function setStage(name, status) {
  const el = document.querySelector(`.stage[data-stage="${name}"]`);
  if (el) el.className = `stage ${status}`;
}

function setPhase(name, status, pct) {
  const el = document.querySelector(`.phase[data-phase="${name}"]`);
  if (!el) return;
  el.querySelector('.phase-head span:last-child').textContent = status;
  el.querySelector('.phase-head span:last-child').className =
    status === 'CREATE_COMPLETE' || status === 'done' ? 'status-ok'
    : status === 'failed' ? 'status-err'
    : status === 'pending' ? 'status-pending' : 'status-warn';
  if (typeof pct === 'number') el.querySelector('.progress-bar').style.width = pct + '%';
}

function creds(prefix) {
  return {
    accessKeyId: $(`${prefix}-key`).value.trim(),
    secretAccessKey: $(`${prefix}-secret`).value.trim(),
    sessionToken: $(`${prefix}-token`).value.trim(),
    region: $(`${prefix}-region`).value.trim(),
  };
}

// ── 1. Discover ────────────────────────────────────────────────────────────
$('btn-discover').onclick = async () => {
  $('btn-discover').disabled = true;
  setStage('discovery', 'active');
  try {
    const resp = await fetch('/api/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceRegion: $('src-region').value, sourceCreds: creds('src') }),
    });
    const data = await resp.json();
    state.sessionId = data.sessionId;
    state.clusters = data.clusters || [];
    setStage('discovery', 'done');
    setStage('graph', 'done');
    show('plan-panel');
    renderResources();
  } catch (e) {
    setStage('discovery', 'failed');
    alert('Discovery failed: ' + e.message);
  } finally {
    $('btn-discover').disabled = false;
  }
};

function renderResources() {
  const list = $('resource-list');
  list.innerHTML = '';
  for (const cluster of state.clusters) {
    for (const r of cluster.resources) {
      const div = document.createElement('div');
      div.className = 'resource';
      div.innerHTML = `<input type="checkbox" checked data-id="${r.id}">
        <span style="flex:1">${r.name || r.id}</span>
        <span class="badge">${r.type.split('::').slice(1).join(' ')}</span>
        <span class="badge">${r.strategy || '—'}</span>`;
      list.appendChild(div);
    }
  }
}

// ── 2. Plan ────────────────────────────────────────────────────────────────
$('btn-plan').onclick = async () => {
  state.selectedResourceIds = [...document.querySelectorAll('#resource-list input:checked')].map(c => c.dataset.id);
  setStage('assessment', 'active');
  try {
    const resp = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        scopedResourceIds: state.selectedResourceIds,
        targetRegion: $('tgt-region').value,
        targetAccountId: $('tgt-account').value,
        isCrossAccount: !!$('tgt-account').value,
      }),
    });
    const data = await resp.json();
    state.planId = data.planId;
    setStage('assessment', 'done');
    setStage('cfn', 'done');
    $('cost-summary').textContent =
      `Migration cost: ~$${data.migrationCost?.oneTimeTransferUsd ?? 0} one-time + $${data.migrationCost?.temporaryStorageUsdPerMonth ?? 0}/mo temp · Target: check pricing`;
    show('execute-panel');
  } catch (e) {
    setStage('assessment', 'failed');
    alert('Plan failed: ' + e.message);
  }
};

$('btn-view-cfn').onclick = async () => {
  if (!state.planId) return;
  const resp = await fetch(`/api/plan/${state.planId}`);
  const data = await resp.json();
  $('cfn-view').textContent = (data.cfnTemplates || []).map(t => `# ${t.stackName}\n${t.yaml}`).join('\n\n');
  show('cfn-view');
};

$('btn-view-manifest').onclick = async () => {
  if (!state.planId) return;
  const resp = await fetch(`/api/plan/${state.planId}`);
  const data = await resp.json();
  $('cfn-view').textContent = data.manifest || 'No manifest';
  show('cfn-view');
};

// ── 3. Execute (SSE progress) ────────────────────────────────────────────────
$('btn-execute').onclick = async () => {
  if (!confirm('Execute migration? This creates resources in the TARGET account/region.')) return;
  $('btn-execute').disabled = true;
  try {
    const resp = await fetch('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: state.planId, targetCreds: creds('tgt'), approved: true }),
    });
    const { executionId } = await resp.json();
    state.executionId = executionId;

    // Stream progress via SSE
    const es = new EventSource(`/api/execute/${executionId}/stream`);
    show('exec-log');
    es.onmessage = (ev) => {
      const evt = JSON.parse(ev.data);
      const log = $('exec-log');
      log.textContent += `[${evt.type}] ${evt.phase || ''} ${evt.message || ''}\n`;
      if (evt.type === 'phase_start') setPhase(evt.phase, 'running', 0);
      if (evt.type === 'phase_progress') setPhase(evt.phase, 'running', evt.percent);
      if (evt.type === 'phase_complete') setPhase(evt.phase, 'CREATE_COMPLETE', 100);
      if (evt.type === 'phase_failed') setPhase(evt.phase, 'failed', 0);
      if (evt.type === 'done') { es.close(); $('btn-execute').disabled = false; }
    };
    es.onerror = () => { es.close(); $('btn-execute').disabled = false; };
  } catch (e) {
    alert('Execution failed to start: ' + e.message);
    $('btn-execute').disabled = false;
  }
};

$('btn-rollback').onclick = async () => {
  if (!state.executionId) return;
  if (!confirm('Rollback? This deletes the target stacks created so far.')) return;
  await fetch(`/api/execute/${state.executionId}/rollback`, { method: 'POST' });
};
