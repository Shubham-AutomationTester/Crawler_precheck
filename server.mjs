import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const scaleSetting = Number(process.env.QA_DELAY_SCALE ?? '1');
const DELAY_SCALE = Number.isFinite(scaleSetting) && scaleSetting > 0 && scaleSetting <= 1 ? scaleSetting : 1;
const ROOT_SCENARIO = process.env.ROOT_SCENARIO || '';
const ROOT_RUN = process.env.ROOT_RUN || 'root';
const TTL_MS = 3 * 60 * 60 * 1000;
const MAX_RUNS = 1200;
const runs = new Map();

// Test plans are HTTP requests in arrival order, NOT the crawler's internal retry count.
// Subsequent requests intentionally return HTTP 200 immediately, making extra attempts visible.
const cases = [
  { id: 'fast-200', title: 'Immediate HTTP 200', group: 'Core', objective: 'Baseline: first pre-check succeeds without fallback.', expectation: 'First attempt succeeds; no 2-second wait or retry; crawl completes.', steps: [{ delayMs: 0, status: 200 }] },
  { id: 'slow-under-10', title: 'Slow but within first timeout', group: 'Core', objective: 'Check a 7-second response completes on the first attempt.', expectation: 'First attempt succeeds within 10 seconds; no fallback; crawl completes.', steps: [{ delayMs: 7000, status: 200 }] },
  { id: 'retry-success', title: 'First timeout, fast recovery', group: 'Core', objective: 'Force a >10-second first response and a fast successful fallback.', expectation: 'Attempt 1 times out at ~10s; wait ~2s; attempt 2 succeeds with a 20s limit; same job crawls.', steps: [{ delayMs: 12000, status: 200 }, { delayMs: 400, status: 200 }] },
  { id: 'retry-slow-success', title: 'First timeout, slow recovery', group: 'Core', objective: 'Validate the fallback really allows more than 10 seconds.', expectation: 'Attempt 1 times out; wait ~2s; attempt 2 completes in ~17s (within 20s); crawl succeeds.', steps: [{ delayMs: 12000, status: 200 }, { delayMs: 17000, status: 200 }] },
  { id: 'retry-both-timeout', title: 'Both attempts exceed timeouts', group: 'Core', objective: 'Force >10-second first response and >20-second fallback response.', expectation: 'Attempts time out at ~10s and ~20s; no third attempt; SAME crawl job is marked Failed.', steps: [{ delayMs: 12000, status: 200 }, { delayMs: 23000, status: 200 }] },
  { id: 'first-503', title: 'Immediate HTTP 503', group: 'Regression', objective: 'Non-timeout HTTP failure on the first attempt.', expectation: 'Verify the existing HTTP-error policy; a timeout-only fallback should not be introduced for 503.', steps: [{ delayMs: 0, status: 503 }, { delayMs: 0, status: 200 }] },
  { id: 'retry-503', title: 'Timeout then HTTP 503', group: 'Regression', objective: 'Second attempt responds quickly but with an error.', expectation: 'First attempt times out; second receives HTTP 503; check existing failure semantics; never make a third pre-check.', steps: [{ delayMs: 12000, status: 200 }, { delayMs: 0, status: 503 }] },
  { id: 'first-404', title: 'Immediate HTTP 404', group: 'Regression', objective: 'Ensure the change does not hide invalid start URLs.', expectation: 'Verify existing 404 handling; no new timeout fallback should be triggered by a fast 404 alone.', steps: [{ delayMs: 0, status: 404 }, { delayMs: 0, status: 200 }] },
  { id: 'redirect-302', title: 'Immediate HTTP 302 redirect', group: 'Regression', objective: 'Verify the existing redirect behavior is preserved.', expectation: 'Redirect handling follows existing crawler policy; do not mistake the redirect for a timeout.', steps: [{ delayMs: 0, status: 302 }] },
  { id: 'first-boundary-9-5', title: '9.5-second first response', group: 'Boundary', objective: 'Probe response timing near the first 10-second limit.', expectation: 'Boundary is transport-sensitive; inspect measured duration and whether the fallback ran.', steps: [{ delayMs: 9500, status: 200 }] },
  { id: 'second-boundary-19-5', title: '19.5-second fallback response', group: 'Boundary', objective: 'Probe response timing near the second 20-second limit.', expectation: 'Boundary is transport-sensitive; inspect actual request duration and timeout handling.', steps: [{ delayMs: 12000, status: 200 }, { delayMs: 19500, status: 200 }] },
];
const caseById = new Map(cases.map(item => [item.id, item]));
if (ROOT_SCENARIO && !caseById.has(ROOT_SCENARIO)) {
  console.error(`Invalid ROOT_SCENARIO: ${ROOT_SCENARIO}`);
  process.exit(1);
}
const validToken = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const output = (event, data) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

function safeHtml(input) {
  return String(input).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function send(res, status, body, contentType, extraHeaders = {}, method = 'GET') {
  const content = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(content.length),
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(method === 'HEAD' ? undefined : content);
}
function json(res, status, obj, method = 'GET') {
  send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8', {}, method);
}
function requestKey(caseId, run) { return `${caseId}::${run}`; }
function pruneRuns() {
  const now = Date.now();
  for (const [key, state] of runs) {
    if (now - state.updatedAt > TTL_MS && state.events.every(e => e.outcome !== 'pending')) runs.delete(key);
  }
  if (runs.size <= MAX_RUNS) return;
  for (const [key, state] of runs) {
    if (runs.size <= MAX_RUNS) break;
    if (state.events.every(e => e.outcome !== 'pending')) runs.delete(key);
  }
}
function getRun(caseId, run) {
  const key = requestKey(caseId, run);
  let state = runs.get(key);
  if (!state) {
    pruneRuns();
    state = { caseId, run, createdAt: new Date().toISOString(), updatedAt: Date.now(), events: [] };
    runs.set(key, state);
  }
  state.updatedAt = Date.now();
  return state;
}
function getRunSnapshot(caseId, run) {
  const state = runs.get(requestKey(caseId, run));
  return { case: caseId, run, request_count: state?.events.length || 0, events: state?.events.map(e => ({...e})) || [], created_at: state?.createdAt || null };
}
function htmlPage({caseId, token, requestNumber, status}) {
  const c = caseById.get(caseId);
  const base = `/case/${encodeURIComponent(caseId)}/${encodeURIComponent(token)}`;
  const link = (name, text) => `<li><a href="${base}/${name}">${text}</a></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeHtml(c.title)} | QA Fixture</title><meta name="description" content="SearchStax crawler pre-check regression fixture"></head>
<body style="font-family:system-ui,sans-serif;margin:0;background:#f7f9fc;color:#19243a"><main style="max-width:850px;margin:42px auto;padding:24px;background:white;border-radius:16px;box-shadow:0 4px 28px #1e293b12">
<p style="color:#445c85;font-weight:700">SEARCHSTAX QA FIXTURE / ${safeHtml(caseId)}</p><h1>${safeHtml(c.title)}</h1><p>${safeHtml(c.objective)}</p>
<p><strong>Run ID:</strong> <code>${safeHtml(token)}</code></p><p><strong>Request number:</strong> ${requestNumber} &bull; <strong>HTTP status:</strong> ${status}</p>
<h2>Crawlable content</h2><p>This page is intentionally indexable. All child URLs return immediately, so the pre-check is the only intentional delay.</p>
<ul>${link('page-1', 'Crawler test article 1')}${link('page-2', 'Crawler test article 2')}${link('page-3', 'Crawler test article 3')}</ul>
<p><a href="/dashboard">Back to QA dashboard</a> (opening the test start URL again counts as a new request)</p>
</main></body></html>`;
}
function childPage(caseId, token, pageId) {
  const base = `/case/${encodeURIComponent(caseId)}/${encodeURIComponent(token)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Crawler QA ${pageId} | ${safeHtml(caseId)}</title></head><body><main><h1>Crawler regression test ${safeHtml(pageId)}</h1><p>Case ${safeHtml(caseId)}. Run ${safeHtml(token)}. Child content is fast and indexable.</p><a href="${base}/page-1">Article 1</a> | <a href="${base}/page-2">Article 2</a> | <a href="${base}/page-3">Article 3</a></main></body></html>`;
}
function servePublic(res, filename, method) {
  const types = { 'index.html': 'text/html; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'dashboard.js': 'text/javascript; charset=utf-8', 'favicon.svg': 'image/svg+xml' };
  if (!Object.hasOwn(types, filename)) return json(res, 404, { error: 'Not found' }, method);
  const body = fs.readFileSync(path.join(__dirname, 'public', filename));
  send(res, 200, body, types[filename], {}, method);
}
function applyScenario(req, res, c, run) {
  const state = getRun(c.id, run);
  const n = state.events.length + 1;
  const step = c.steps[Math.min(n - 1, c.steps.length - 1)];
  // After the scripted pre-check requests, default to a fast successful page.
  const actualStep = n > c.steps.length ? { delayMs: 0, status: 200 } : step;
  const delayMs = Math.round(actualStep.delayMs * DELAY_SCALE);
  const timerStart = performance.now();
  const entry = {
    number: n, method: req.method, started_at: new Date().toISOString(),
    configured_delay_ms: actualStep.delayMs, effective_delay_ms: delayMs,
    configured_http_status: actualStep.status, elapsed_ms: null,
    completed_at: null, outcome: 'pending', user_agent: (req.headers['user-agent'] || '').slice(0, 140),
  };
  state.events.push(entry);
  output('qa.request_received', {case: c.id, run, request_number: n, method: req.method, planned_delay_ms: actualStep.delayMs, status: actualStep.status});
  let timer = null;
  let completed = false;
  function complete(outcome) {
    if (completed) return;
    completed = true;
    entry.outcome = outcome;
    entry.elapsed_ms = Math.round(performance.now() - timerStart);
    entry.completed_at = new Date().toISOString();
    state.updatedAt = Date.now();
    output(outcome === 'client_disconnected' ? 'qa.client_disconnected' : 'qa.response_sent', {
      case: c.id, run, request_number: n, method: req.method, elapsed_ms: entry.elapsed_ms, planned_delay_ms: actualStep.delayMs,
      http_status: actualStep.status, outcome,
    });
  }
  res.on('finish', () => complete('response_sent'));
  res.on('close', () => {
    if (!res.writableEnded) {
      if (timer !== null) clearTimeout(timer);
      complete('client_disconnected');
    }
  });
  timer = setTimeout(() => {
    if (res.destroyed || completed) return;
    const extra = {
      'X-QA-Case': c.id, 'X-QA-Run': run, 'X-QA-Request-Number': String(n),
      'X-QA-Planned-Delay-Ms': String(actualStep.delayMs),
    };
    if (actualStep.status === 302) {
      send(res, 302, 'Redirecting to article', 'text/plain; charset=utf-8', { ...extra, Location: `/case/${c.id}/${run}/page-1` }, req.method);
    } else {
      send(res, actualStep.status, htmlPage({caseId: c.id, token: run, requestNumber: n, status: actualStep.status}), 'text/html; charset=utf-8', extra, req.method);
    }
  }, delayMs);
}

async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && pathname === '/api/reset')) {
    return json(res, 405, { error: 'Method not allowed' }, req.method);
  }
  if (pathname === '/health') return json(res, 200, { ok: true, service: 'crawler-precheck-qa', uptime_s: Math.round(process.uptime()), root_scenario: ROOT_SCENARIO || null }, req.method);
  if (pathname === '/api/scenarios') return json(res, 200, { cases: cases.map(({steps, ...item}) => ({...item, steps})), root_scenario: ROOT_SCENARIO || null, delay_scale: DELAY_SCALE }, req.method);
  if (pathname === '/api/observations') {
    const c = url.searchParams.get('case');
    const run = url.searchParams.get('run');
    if (!caseById.has(c) || !validToken(run)) return json(res, 400, {error:'Specify a valid case and run.'}, req.method);
    return json(res, 200, getRunSnapshot(c, run), req.method);
  }
  if (pathname === '/api/reset') {
    let body = '';
    try {
      for await (const part of req) { body += part.toString(); if (body.length > 4000) throw new Error('Body too long'); }
      const data = JSON.parse(body);
      if (!caseById.has(data.case) || !validToken(data.run)) return json(res, 400, {error:'Invalid case or run.'});
      const key = requestKey(data.case, data.run);
      if (runs.get(key)?.events.some(e => e.outcome === 'pending')) return json(res, 409, {error:'Cannot reset a run with in-flight requests.'});
      runs.delete(key);
      output('qa.run_reset', {case:data.case, run:data.run});
      return json(res, 200, { ok:true, case:data.case, run:data.run });
    } catch (error) { return json(res, 400, {error: String(error.message || error)}); }
  }
  if (pathname === '/robots.txt') {
    return send(res, 200, 'User-agent: *\nDisallow: /api/\nDisallow: /dashboard\nAllow: /case/\n', 'text/plain; charset=utf-8', {}, req.method);
  }
  if (pathname === '/sitemap.xml') {
    const origin = `${(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers.host || 'localhost'}`;
    return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${safeHtml(origin)}/content/sample</loc></url></urlset>`, 'application/xml; charset=utf-8', {}, req.method);
  }
  if (pathname === '/dashboard' || (pathname === '/' && !ROOT_SCENARIO)) return servePublic(res, 'index.html', req.method);
  if (pathname === '/styles.css') return servePublic(res, 'styles.css', req.method);
  if (pathname === '/dashboard.js') return servePublic(res, 'dashboard.js', req.method);
  if (pathname === '/favicon.svg') return servePublic(res, 'favicon.svg', req.method);
  if (pathname === '/content/sample') return send(res, 200, '<!doctype html><title>Crawl QA Sample</title><h1>Sample indexed page</h1><p>Fast, indexable content for regression.</p>', 'text/html; charset=utf-8', {}, req.method);
  if (pathname === '/' && ROOT_SCENARIO) return applyScenario(req, res, caseById.get(ROOT_SCENARIO), ROOT_RUN);
  const match = pathname.match(/^\/case\/([a-z0-9-]+)\/([a-zA-Z0-9_-]{1,80})\/?(?:\/(page-[123]))?\/?$/);
  if (match) {
    const [, caseId, token, child] = match;
    if (!caseById.has(caseId)) return json(res, 404, {error:'Unknown test case.'}, req.method);
    if (child) return send(res, 200, childPage(caseId, token, child), 'text/html; charset=utf-8', {'X-QA-Case':caseId,'X-QA-Run':token}, req.method);
    return applyScenario(req, res, caseById.get(caseId), token);
  }
  return json(res, 404, { error: 'Not found', dashboard: '/dashboard' }, req.method);
}

const server = http.createServer((req,res) => {
  Promise.resolve(handler(req,res)).catch(error => {
    output('qa.handler_error', { error: error.message });
    if (!res.headersSent) json(res, 500, {error:'Internal server error'});
    else res.destroy();
  });
});
server.requestTimeout = 60_000;
server.headersTimeout = 65_000;
server.listen(PORT, '0.0.0.0', () => output('qa.fixture_started', {
  port: PORT, case_count: cases.length, delay_scale: DELAY_SCALE,
  root_scenario: ROOT_SCENARIO || null, dashboard: ROOT_SCENARIO ? '/dashboard' : '/'
}));
