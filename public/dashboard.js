const elements = {
  grid: document.getElementById('scenarioGrid'), count: document.getElementById('scenarioCount'),
  tabs: document.getElementById('tabs'), noSelection: document.getElementById('noSelection'), selection: document.getElementById('selection'),
  testUrl: document.getElementById('testUrl'), selectedScenario: document.getElementById('selectedScenario'), status: document.getElementById('runStatus'),
  observations: document.getElementById('observations'), requestCount: document.getElementById('requestCount'), lastResult: document.getElementById('lastResult'), runToken: document.getElementById('runToken'),
  rawJson: document.getElementById('rawJson'), copyUrl: document.getElementById('copyUrl'), newRun: document.getElementById('newRun'), refresh: document.getElementById('refresh'), resetRun: document.getElementById('resetRun')
};
let cases = [];
let active = null;
let filter = 'All';
let updateSequence = 0;

function makeEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function readableDelay(ms) { return ms ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : 'instant'; }
function description(steps, index) { return `${index + 1}: ${readableDelay(steps.delayMs)} · HTTP ${steps.status}`; }
function token() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}
function scenarioUrl(c, run) { return `${location.origin}/case/${c.id}/${run}`; }
function renderCards() {
  elements.grid.replaceChildren();
  const shown = cases.filter(c => filter === 'All' || c.group === filter);
  elements.count.textContent = `${shown.length} test scenario${shown.length === 1 ? '' : 's'}`;
  for (const c of shown) {
    const card = makeEl('article', `scenario-card${active?.c.id === c.id ? ' is-selected' : ''}`);
    const top = makeEl('div', 'card-top');
    top.append(makeEl('span', 'case-id', c.id.toUpperCase()));
    top.append(makeEl('span', `tag ${c.group.toLowerCase()}`, c.group));
    card.append(top);
    card.append(makeEl('h3', '', c.title));
    card.append(makeEl('p', '', c.objective));
    const steps = makeEl('div', 'steps');
    c.steps.forEach((s, idx) => {
      if (idx > 0) steps.append(makeEl('span', 'step-arrow', '→'));
      steps.append(makeEl('span', 'step-chip', description(s, idx)));
    });
    card.append(steps);
    const action = makeEl('button', 'card-button', 'Generate URL');
    action.type = 'button';
    action.addEventListener('click', () => generate(c));
    card.append(action);
    elements.grid.append(card);
  }
}
function generate(c, customToken = null) {
  active = {c, run: customToken || token()};
  const url = scenarioUrl(c, active.run);
  elements.testUrl.value = url;
  elements.selectedScenario.textContent = `Expected: ${c.expectation}`;
  elements.runToken.textContent = active.run;
  elements.rawJson.href = `/api/observations?case=${encodeURIComponent(c.id)}&run=${encodeURIComponent(active.run)}`;
  elements.noSelection.hidden = true;
  elements.selection.hidden = false;
  elements.status.textContent = 'Monitoring';
  elements.status.className = 'status active';
  elements.observations.replaceChildren(makeEl('tr'));
  const row = elements.observations.querySelector('tr');
  const cell = makeEl('td', 'placeholder', 'No requests yet. Start a crawler job using the URL above.');
  cell.colSpan = 6;
  row.append(cell);
  elements.requestCount.textContent = '0';
  elements.lastResult.textContent = '—';
  renderCards();
  document.getElementById('monitor').scrollIntoView({behavior: 'smooth', block: 'start'});
  void poll();
}
async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const tmp = makeEl('textarea');
    tmp.value = value;
    tmp.style.position = 'fixed'; tmp.style.opacity = '0';
    document.body.append(tmp); tmp.select();
    const success = document.execCommand('copy'); tmp.remove();
    if (!success) throw new Error('Copy failed. Select the URL text and copy manually.');
  }
}
async function poll() {
  if (!active) return;
  const seq = ++updateSequence;
  const currentKey = `${active.c.id}/${active.run}`;
  try {
    const response = await fetch(`/api/observations?case=${encodeURIComponent(active.c.id)}&run=${encodeURIComponent(active.run)}`, {cache:'no-store'});
    if (!response.ok) throw new Error(`Monitor returned HTTP ${response.status}`);
    const body = await response.json();
    if (seq !== updateSequence || !active || currentKey !== `${active.c.id}/${active.run}`) return;
    elements.requestCount.textContent = String(body.request_count);
    elements.lastResult.textContent = body.events.length ? body.events.at(-1).outcome.replaceAll('_', ' ') : '—';
    elements.observations.replaceChildren();
    if (!body.events.length) {
      const tr = makeEl('tr'), td = makeEl('td', 'placeholder', 'No requests yet. Start a crawler job using the URL above.');
      td.colSpan = 6; tr.append(td); elements.observations.append(tr); return;
    }
    for (const entry of body.events) {
      const tr = makeEl('tr');
      for (const value of [String(entry.number), entry.method, readableDelay(entry.configured_delay_ms), `HTTP ${entry.configured_http_status}`]) tr.append(makeEl('td', '', value));
      const status = makeEl('td');
      status.append(makeEl('span', `result ${entry.outcome}`, entry.outcome.replaceAll('_', ' ')));
      tr.append(status);
      tr.append(makeEl('td', '', entry.elapsed_ms === null ? 'in progress' : `${(entry.elapsed_ms / 1000).toFixed(2)}s`));
      elements.observations.append(tr);
    }
  } catch (err) {
    if (seq === updateSequence) elements.lastResult.textContent = `Monitor error: ${err.message}`;
  }
}
async function reset() {
  if (!active) return;
  if (!confirm('Reset the request counter for this run? Do not reset while a crawl is active.')) return;
  const r = await fetch('/api/reset', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({case:active.c.id,run:active.run})});
  const result = await r.json();
  if (!r.ok) return alert(result.error || 'Unable to reset.');
  await poll();
}
async function init() {
  try {
    const result = await (await fetch('/api/scenarios', {cache:'no-store'})).json();
    cases = result.cases;
    if (result.root_scenario) {
      const note = document.createElement('p');
      note.className = 'callout';
      note.textContent = `Root URL simulation is active (${result.root_scenario}). To test the domain root, use ${location.origin}/ as Start URL. Monitor it with case=${result.root_scenario}, run=root (or ROOT_RUN).`;
      document.querySelector('.hero').after(note);
    }
    renderCards();
  } catch (err) {
    elements.grid.textContent = `Unable to load test scenarios: ${err.message}`;
  }
}
elements.tabs.addEventListener('click', e => {
  const target = e.target.closest('button[data-filter]');
  if (!target) return;
  filter = target.dataset.filter;
  for (const button of elements.tabs.querySelectorAll('button')) button.classList.toggle('active', button === target);
  renderCards();
});
elements.copyUrl.addEventListener('click', async () => {
  try {
    await copyText(elements.testUrl.value);
    elements.copyUrl.textContent = 'Copied ✓';
    setTimeout(() => {elements.copyUrl.textContent = 'Copy URL';}, 1600);
  } catch (err) { alert(err.message); }
});
elements.newRun.addEventListener('click', () => { if (active) generate(active.c); });
elements.refresh.addEventListener('click', () => { void poll(); });
elements.resetRun.addEventListener('click', () => { void reset(); });
setInterval(() => {if (active) void poll();}, 2300);
void init();
