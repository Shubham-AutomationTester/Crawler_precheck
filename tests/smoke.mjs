import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {randomUUID} from 'node:crypto';

let server;
let origin;
async function freePort() {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readMonitor(c, run) {
  const response = await fetch(`${origin}/api/observations?case=${c}&run=${run}`);
  assert.equal(response.status, 200);
  return response.json();
}
async function waitForEvent(c, run, index, expected, timeLimit = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeLimit) {
    const observations = await readMonitor(c, run);
    if (observations.events[index]?.outcome === expected) return observations.events[index];
    await pause(20);
  }
  throw Error(`Expected ${c}/${run} entry ${index + 1} to be ${expected}`);
}
async function attemptWithTimeout(url, timeoutMs) {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
    await response.text();
    return {status: response.status, timedOut: false};
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return {timedOut: true};
    throw error;
  }
}

before(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: {...process.env, PORT: String(port), QA_DELAY_SCALE: '0.02'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => {output += chunk.toString();});
  server.stderr.on('data', chunk => {output += chunk.toString();});
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error(`Server exited. Output: ${output}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch { /* server starting */ }
    await pause(25);
  }
  throw Error(`Service did not start: ${output}`);
});
after(() => {if (server && server.exitCode === null) server.kill('SIGTERM');});

test('dashboard, static assets and health work', async () => {
  for (const endpoint of ['/', '/dashboard', '/styles.css', '/dashboard.js', '/favicon.svg', '/robots.txt', '/sitemap.xml', '/health']) {
    const response = await fetch(`${origin}${endpoint}`);
    assert.equal(response.status, 200, endpoint);
  }
  const dashboard = await (await fetch(origin)).text();
  assert.match(dashboard, /Crawler pre-check/);
  const catalog = await (await fetch(`${origin}/api/scenarios`)).json();
  assert.equal(catalog.cases.length, 11);
  assert.equal(catalog.delay_scale, 0.02);
});

test('immediate success, child links and HEAD work', async () => {
  const run = randomUUID();
  const route = `${origin}/case/fast-200/${run}`;
  const first = await fetch(route);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-qa-request-number'), '1');
  const html = await first.text();
  assert.match(html, /page-1/);
  const child = await fetch(`${route}/page-1`);
  assert.equal(child.status, 200);
  assert.match(await child.text(), /fast and indexable/);
  const second = await fetch(route, {method:'HEAD'});
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-qa-request-number'), '2');
  const snapshot = await readMonitor('fast-200', run);
  assert.equal(snapshot.request_count, 2);
  assert.equal(snapshot.events[0].outcome, 'response_sent');
});

test('client first timeout, 2-second scaled pause, fallback success', async () => {
  const run = randomUUID();
  const route = `${origin}/case/retry-success/${run}`;
  const first = await attemptWithTimeout(route, 200);
  assert.equal(first.timedOut, true);
  await waitForEvent('retry-success', run, 0, 'client_disconnected');
  await pause(40);
  const second = await attemptWithTimeout(route, 400);
  assert.equal(second.timedOut, false);
  assert.equal(second.status, 200);
  const observations = await readMonitor('retry-success', run);
  assert.equal(observations.request_count, 2);
  assert.deepEqual(observations.events.map(e => e.configured_delay_ms), [12000, 400]);
  assert.deepEqual(observations.events.map(e => e.outcome), ['client_disconnected', 'response_sent']);
});

test('both attempts exceed respective timeouts; no additional request', async () => {
  const run = randomUUID();
  const route = `${origin}/case/retry-both-timeout/${run}`;
  assert.equal((await attemptWithTimeout(route, 200)).timedOut, true);
  await waitForEvent('retry-both-timeout', run, 0, 'client_disconnected');
  await pause(40);
  assert.equal((await attemptWithTimeout(route, 400)).timedOut, true);
  await waitForEvent('retry-both-timeout', run, 1, 'client_disconnected');
  const observations = await readMonitor('retry-both-timeout', run);
  assert.equal(observations.request_count, 2);
  assert.deepEqual(observations.events.map(e => e.configured_delay_ms), [12000, 23000]);
});

test('HTTP errors and redirects preserve configured status', async () => {
  for (const [caseId, expected] of [['first-503',503],['first-404',404],['retry-503',200]]) {
    const run = randomUUID();
    const response = await fetch(`${origin}/case/${caseId}/${run}`, {redirect:'manual'});
    assert.equal(response.status, expected);
  }
  const run = randomUUID();
  const response = await fetch(`${origin}/case/redirect-302/${run}`, {redirect:'manual'});
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /page-1$/);
});

test('reset isolates counters and does not affect another run', async () => {
  const a = randomUUID(), b = randomUUID();
  await fetch(`${origin}/case/fast-200/${a}`);
  await fetch(`${origin}/case/fast-200/${b}`);
  const response = await fetch(`${origin}/api/reset`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({case:'fast-200',run:a})
  });
  assert.equal(response.status, 200);
  assert.equal((await readMonitor('fast-200',a)).request_count, 0);
  assert.equal((await readMonitor('fast-200',b)).request_count, 1);
  await fetch(`${origin}/case/fast-200/${a}`);
  assert.equal((await readMonitor('fast-200',a)).events[0].number, 1);
});

test('invalid scenario never creates log entries', async () => {
  assert.equal((await fetch(`${origin}/case/not-existing/${randomUUID()}`)).status, 404);
  assert.equal((await fetch(`${origin}/api/observations?case=fast-200&run=oops%20space`)).status, 400);
});

test('slow fallback responds after >10 simulated seconds but before 20', async () => {
  const run = randomUUID();
  const route = `${origin}/case/retry-slow-success/${run}`;
  assert.equal((await attemptWithTimeout(route, 200)).timedOut, true);
  await waitForEvent('retry-slow-success',run,0,'client_disconnected');
  await pause(40);
  const second = await attemptWithTimeout(route, 650);
  assert.equal(second.timedOut, false);
  assert.equal(second.status, 200);
  const observation = await readMonitor('retry-slow-success',run);
  assert.equal(observation.events[1].configured_delay_ms, 17000);
  assert.ok(observation.events[1].elapsed_ms >= 300);
});

test('root mode can simulate site-root pre-check without consuming dashboard or health', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const rootServer = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: {...process.env, PORT: String(port), ROOT_SCENARIO: 'retry-success', ROOT_RUN:'root', QA_DELAY_SCALE:'0.02'},
    stdio:'ignore'
  });
  try {
    let started = false;
    for (let n=0; n<100; n++) {
      try { if ((await fetch(`${url}/health`)).ok) {started=true;break;} } catch { /* starting */ }
      await pause(25);
    }
    assert.equal(started,true);
    assert.equal((await fetch(`${url}/dashboard`)).status, 200);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    let state = await (await fetch(`${url}/api/observations?case=retry-success&run=root`)).json();
    assert.equal(state.request_count, 0);
    assert.equal((await fetch(`${url}/`)).status, 200);
    state = await (await fetch(`${url}/api/observations?case=retry-success&run=root`)).json();
    assert.equal(state.request_count, 1);
    assert.equal(state.events[0].configured_delay_ms, 12000);
  } finally {
    rootServer.kill('SIGTERM');
  }
});
