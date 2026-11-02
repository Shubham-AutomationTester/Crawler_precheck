# Crawler Pre-check QA Lab — STUDIO-6210

A ready-to-deploy, **Node.js web service** for testing SearchStax crawler pre-check timeouts and the one-time fallback. Runs on a **Render free Web Service** without third-party npm packages.

**Jira:** https://searchstax.atlassian.net/browse/STUDIO-6210

## Acceptance behavior to validate

1. Attempt 1 has a **10-second timeout**.
2. **Only if attempt 1 times out**, wait **2 seconds**.
3. Attempt 2 has a **20-second timeout**.
4. If both attempts fail, mark the **same crawl job Failed**; do not spawn a new job or start a third pre-check.
5. Log each attempt's **duration, configured timeout, and result**.
6. Existing successful crawls and error handling must not regress.

This fixture controls **server response delays and HTTP status codes**. It does **not** implement the crawler retry policy or fake crawler job states; verify those in SearchStax and its logs.

## File structure

```text
searchstax-crawler-precheck-qa/
├── server.mjs                 Node.js HTTP server + deterministic scenarios
├── package.json               No external dependencies
├── render.yaml                Optional Render Blueprint, free plan
├── public/
│   ├── index.html              QA dashboard with test URL generator
│   ├── styles.css
│   ├── dashboard.js             Live request monitor
│   └── favicon.svg
├── tests/smoke.mjs            Automated integration / smoke tests
├── test-matrix.csv            QA scenarios + expected results
└── README.md
```

## Deploy on Render (free)

1. Extract this ZIP and upload the **contents** to a new GitHub repository (the repository root must contain `server.mjs` and `package.json`).
2. Go to https://dashboard.render.com/ and select **New > Web Service**.
3. Connect your GitHub repository; set:

   | Setting | Value |
   | --- | --- |
   | Language/Runtime | Node |
   | Branch | Your deployed branch (often `main`) |
   | Root Directory | Empty (if the files are in the repository root) |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | Free |
   | Health Check Path | `/health` |

4. Deploy. The service binds to Render's `PORT` automatically. Open `https://YOUR-SERVICE.onrender.com/` for the dashboard.
5. Alternatively deploy using the included `render.yaml` Blueprint (the file configures a free Node Web Service).

**Important:** Use a **Web Service**, not a Static Site. A static site cannot reliably implement these per-request 12s/23s waits, intentional HTTP failures, or request counters.

### Run locally

```bash
node --version             # Node.js 20+
npm install                # No third-party dependencies
npm start
# Dashboard: http://localhost:10000/
```

Run smoke tests:

```bash
npm test
```

## Recommended end-to-end workflow

1. Open the Render dashboard's `/health` endpoint once to confirm the service is awake. **This does not consume a scenario request**.
2. On the dashboard, choose a test scenario and click **Generate URL**.
3. Click **Copy URL**. **Do NOT open/paste-and-visit the generated test URL in a browser or run `curl` before starting the crawler**: either action consumes attempt #1.
4. In SearchStax, create or edit a crawler and paste the *full* URL as **Start URL**, for example:

   ```text
   https://YOUR-SERVICE.onrender.com/case/retry-success/a12b3c4d-1234-4567-9876-abcdef012345
   ```

5. Run the crawler once. Keep the QA dashboard open; its monitor refreshes automatically every ~2.3 seconds.
6. Check server observations: request number, planned response delay, status, elapsed time, and whether the client disconnected.
7. In SearchStax UI and Datadog/logs, check the actual *pre-check* attempts, timeout configuration, retry interval, and final crawl status. Confirm the crawl/job ID is unchanged between attempts.
8. For another test, click **Generate URL** again to get a new run identifier and isolated request counter.

### What to expect for the key scenarios

| Scenario | HTTP response #1 | HTTP response #2 | Expected crawler behavior |
| --- | --- | --- | --- |
| `fast-200` | 200 immediately | Not expected for pre-check | Crawl proceeds on first attempt |
| `slow-under-10` | 200 after 7s | Not expected for pre-check | Completes within first 10s, no retry |
| `retry-success` | 200 after 12s (too late) | 200 after 0.4s | First times out ~10s; wait ~2s; second succeeds; **same job proceeds** |
| `retry-slow-success` | 200 after 12s (too late) | 200 after 17s | Second must use 20s limit (a 10s fallback would incorrectly fail) |
| `retry-both-timeout` | 200 after 12s (too late) | 200 after 23s (too late) | First times out ~10s; second ~20s; **same job Failed**; no third pre-check |
| `first-503` | 503 immediately | 200 only if extra request | Confirm existing fast HTTP-error policy; timeout-only fallback must not change it |
| `retry-503` | 200 after 12s (too late) | 503 immediately | Check fallback HTTP-error policy; no third pre-check |
| `first-404` | 404 immediately | 200 only if extra request | Existing invalid-URL handling unchanged |
| `redirect-302` | 302 immediately | Not expected for pre-check | Existing redirect behavior unchanged |
| `first-boundary-9-5` | 200 after 9.5s | Not normally expected | **Exploratory**: overhead/cold starts may affect results |
| `second-boundary-19-5` | 200 after 12s | 200 after 19.5s | **Exploratory**: overhead can cross 20s boundary |

After the scripted requests, additional hits to the same scenario **respond immediately with HTTP 200**. This makes unexpected third or fourth requests visible. It also lets the crawler request the Start URL again after a successful pre-check. Each successful scenario HTML page includes 3 indexable child pages that load immediately.

**Critical interpretation:** The monitor counts HTTP requests, not the crawler's internal attempt counter. A crawler may issue additional HEAD/GET requests during validation or to crawl content. Compare the method, sequence, timestamps and SearchStax pre-check logs before attributing a request to a retry. The default test route treats HEAD and GET the same for delay/sequence counting.

### Timing example: successful fallback

Using `retry-success`, expect something similar to:

```text
T+ 0s   pre-check request #1 arrives  -> server plans to reply after 12s
T+10s   crawler request #1 times out; server usually sees disconnect
T+12s   crawler request #2 arrives after 2s wait
T+12.4s request #2 returns HTTP 200
        same crawl job continues; later page fetches return fast 200
```

For `retry-both-timeout`:

```text
T+ 0s   request #1 arrives (server plans 12s)
T+10s   attempt #1 times out
T+12s   request #2 arrives after 2s wait (server plans 23s)
T+32s   attempt #2 times out at its 20-second limit
        same job Failed; no third pre-check
```

Times are approximate, subject to network scheduling, job startup and Render availability. The server reports **`client_disconnected`**, which means the client closed the connection before a response was sent; that can be due to timeout or another reason. Source of truth for crawler timeout and job state is its own logs.

## Server logs and inspection

View the live monitor on the dashboard, or request the JSON for a known run:

```bash
curl 'https://YOUR-SERVICE.onrender.com/api/observations?case=retry-success&run=YOUR-RUN-TOKEN'
```

Render's **Logs** view also emits JSON events:

- `qa.request_received` — method, case, run, request number and configured delay
- `qa.client_disconnected` — caller closed a request before response was sent
- `qa.response_sent` — server returned an HTTP response and measured elapsed time
- `qa.fixture_started` — server startup and configuration

For every pre-check attempt, independently validate the **SearchStax logs** include its timeout value (10000 or 20000 ms), duration and result. Also check the 2-second wait between first timeout and second request. The fixture's server-side logs alone cannot prove those internal values or guarantee the same crawl job was retained.

**Reset an existing run** with the dashboard's Reset button, or:

```bash
curl -X POST 'https://YOUR-SERVICE.onrender.com/api/reset' \
  -H 'Content-Type: application/json' \
  -d '{"case":"retry-success","run":"YOUR-RUN-TOKEN"}'
```

Do not reset while a request is in flight (the API returns HTTP 409). Runs are stored **in memory** and expire after 3 hours of inactivity; a Render restart resets them. No database is needed.

## If your pre-check probes the DOMAIN ROOT instead of the Start URL

Some implementations pre-check `https://host/` rather than the path supplied as Start URL. The default path scenarios **cannot** test a root-only pre-check. If the monitor shows no requests to the selected case during pre-check, inspect the actual requested URL in crawler logs.

This site supports an optional root-test mode via environment variables on Render:

```text
ROOT_SCENARIO=retry-success
ROOT_RUN=root
```

Then redeploy or restart the service, open the dashboard at `/dashboard`, and enter **`https://YOUR-SERVICE.onrender.com/`** as the crawler Start URL. The root will perform the selected scenario. To inspect its requests:

```text
https://YOUR-SERVICE.onrender.com/api/observations?case=retry-success&run=root
```

Before rerunning the same root test, reset the `(case, run)` pair using the reset API. To switch scenarios, change `ROOT_SCENARIO` and redeploy. Supported IDs are returned from `/api/scenarios`. Set `ROOT_SCENARIO` empty or remove it for the normal dashboard at `/`.

Because root mode is shared per service instance, run only one test at a time; every request to `/` (including opening it in a browser) counts against the scenario. `/dashboard`, `/health`, `/robots.txt`, and `/api/observations` never consume root attempts.

## Troubleshooting and caveats

- **Crawler reports failure before scenario request is logged:** check network access, DNS, Render startup, pre-check URL selection, and whether your crawler is targeting the generated Start URL rather than `/`.
- **Already shows 2+ requests before first crawl:** opening the test URL with a browser/HEAD/curl consumes attempts; generate a fresh run.
- **Render logs show `qa.fixture_started` JSON:** normal startup log. Visit `/` (or `/dashboard` when root mode is enabled) to see the web UI.
- **Boundary test unexpectedly times out:** on Free instances, cold starts, proxy/network overhead, and scheduling can push 9.5s/19.5s beyond the configured limits. Treat boundary cases as exploratory rather than primary pass/fail gates.
- **Crawler only indexes the Start URL but no children:** the page has 3 child links. Confirm your crawler's path scope, crawl budget and allow-list settings.
- **Crawler makes additional requests:** could be legitimate GET/HEAD validation and subsequent crawl fetching, not extra retries. Compare with SearchStax logs.
- **Sitemaps/robots:** `/robots.txt` allows the case routes; the sitemap contains a harmless fast sample page and does not pre-consume scripted scenario URLs.
- **Free-instance restarts:** run counters reset on restart; the service is intentionally ephemeral. Re-generate a URL before testing after a service restart. When a Render Free service is asleep, Render may answer `/robots.txt` with `Disallow: /` without waking the service; always warm `/health` before a robots-sensitive crawl.
- **The server does not directly control the crawler's 2-second wait:** it observes arrival times; the crawler itself must implement and log the wait.
- **This is a public QA fixture, not a production app.** Avoid secrets and customer data in run tokens; share the generated URL only as needed.

## QA completion checklist

- [ ] First attempt timeout value is 10 seconds and logged.
- [ ] Timeout triggers exactly one fallback after about 2 seconds.
- [ ] Fallback attempt timeout value is 20 seconds and logged.
- [ ] Fast first-attempt successes do not incur retry/wait.
- [ ] Both-timeout case fails the original crawl job and does not create another job.
- [ ] Each attempt logs timeout, measured duration, and result.
- [ ] HTTP-error and redirect behavior remains consistent with existing policy.
- [ ] Child pages can be crawled and indexed after successful pre-check.
- [ ] No extra pre-check retries, duplicate jobs, or unhandled errors.

**Test matrix:** see `test-matrix.csv` for the exact QA scenarios and Jira/TestRail-friendly steps.
