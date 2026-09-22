# SPEC 02 — Simulation and Measurement Campaign

> **Status:** Draft
> **Depends on:** SPEC 01
> **Date:** 2026-09-22
> **Objective:** Run the SPEC 01 MVP in a 1-CPU / 512MB container under two scripted load scenarios and produce a report proving, with measured event-loop lag, heap, and `/health` latency, that Node.js neither blocks nor saturates memory.

---

## Why this spec exists

SPEC 01 built the MVP. This spec turns it into evidence. The source plan (`02 Simulation and Measurement Strategy.md`) is followed with three deliberate deviations:

- Scenario A lifts the DB2 semaphore (`DB2_MAX_CONCURRENCY=2000`). With the cap at 30, requests queue for minutes and timeouts measure the mock pool, not the event loop.
- Scenario A uses `PAYLOAD_SIZE_MB=1`. At 100MB, 2,000 requests push 200GB through one core — a CPU test, not an I/O test.
- Per-request time is 7.5–9.5s (3 × 1.5s DB2 + 3–5s T2T18), not ~5s. SPEC 01 latencies are kept unchanged.

---

## Scope

**In:**

- `Dockerfile` on `node:22-alpine` running `node src/main.js`.
- `docker-compose.yml` with one `eqa` service, `cpus: 1`, `mem_limit: 512m`, port `3000` published.
- Telemetry logger in `src/main.js` switched to one JSON line per interval on stdout: timestamp, `heapUsed`, `rss`, event-loop lag (p50/p99/max via `perf_hooks.monitorEventLoopDelay`), DB2 in-flight and peak.
- `autocannon` as a devDependency.
- Per-scenario env files: `bench/scenario-a.env`, `bench/scenario-b.env`.
- `/health` probe script: `GET /health` every 100ms for the scenario's duration, per-request latency recorded to JSON.
- Orchestrator `bench/run-scenario.js A|B`: compose up with the env file, wait for `/health`, run probe and autocannon in parallel, save autocannon result, probe result, container logs, and container state to `reports/raw/`, compose down.
- Report generator `bench/build-report.js`: reads `reports/raw/`, writes self-contained `reports/report.html` with Chart.js (CDN) charts per scenario — event-loop lag, heap, RSS, `/health` latency over time.
- Hand-written `reports/REPORT.md` with the verdict and headline numbers.
- npm scripts `bench:a`, `bench:b`, `report`.
- `reports/raw/` added to `.gitignore`.

**Out of scope (for future specs):**

- Clinic.js Doctor profiling.
- k6.
- Repeated runs, worst-of-N aggregation, statistical variance.
- Tuning SPEC 01 latencies to hit the source doc's ~5s per request.
- Scenario variants with the DB2 cap at 30 (pool-sizing study).
- Real OpenShift deployment, Kubernetes manifests, liveness/readiness probes.
- CI integration of the benchmark.
- Automated test suite.
- Any change to domain, ports, use case, or adapters from SPEC 01.

---

## Data model

### Telemetry line

Emitted by `src/main.js` on stdout every `heapLogIntervalMs`, one JSON object per line. Replaces the SPEC 01 `Heap Used: NN MB` and `DB2 In-Flight` text lines.

```js
{
  "type": "telemetry",
  "t": 1758542400000,        // Date.now()
  "heapUsedMb": 42.3,        // process.memoryUsage().heapUsed
  "rssMb": 88.1,             // process.memoryUsage().rss
  "lagP50Ms": 10.2,          // monitorEventLoopDelay, reset each interval
  "lagP99Ms": 11.8,
  "lagMaxMs": 14.0,
  "db2InFlight": 30,
  "db2PeakInFlight": 30
}
```

The startup line becomes `{ "type": "startup", "t": …, "config": {…} }`. Lag histogram resolution: 10ms (`monitorEventLoopDelay({ resolution: 10 })`), so a baseline of ~10ms means idle. Values reported in ms, rounded to one decimal.

### Scenario env files

Consumed by `docker compose --env-file`. `docker-compose.yml` forwards each variable into the container via `environment: KEY: ${KEY:-default}`.

```sh
# bench/scenario-a.env — extreme concurrency, I/O-bound
DB2_MAX_CONCURRENCY=2000
PAYLOAD_SIZE_MB=1
SEED_SIZE=2000

# bench/scenario-b.env — massive streaming
PAYLOAD_SIZE_MB=200
DB2_MAX_CONCURRENCY=30
SEED_SIZE=1000
```

### Scenario definitions

Live in `bench/run-scenario.js` as a constant.

```js
const SCENARIOS = {
  A: { envFile: 'bench/scenario-a.env', connections: 2000, duration: 30, timeout: 30, idRange: 2000 },
  B: { envFile: 'bench/scenario-b.env', connections: 50, amount: 50, timeout: 600, idRange: 50 },
};
```

Autocannon rotates `POST /api/v1/studies/study-{n}/process` with `n` cycling `1…idRange` through `setupRequest`.

### Probe sample

```js
// one entry per /health request
{ "t": 1758542400123, "latencyMs": 3.4, "status": 200 }  // status null on network error
```

### Raw output files

```text
reports/raw/scenario-a.autocannon.json   // autocannon result object
reports/raw/scenario-a.probe.json        // { startedAt, samples: [...] }
reports/raw/scenario-a.telemetry.jsonl   // docker logs, JSON lines only
reports/raw/scenario-a.container.json    // docker compose ps -a output: state, exit code
(same four for scenario-b)
```

### Files created

```text
Dockerfile
.dockerignore
docker-compose.yml
bench/scenario-a.env
bench/scenario-b.env
bench/health-probe.js
bench/run-scenario.js
bench/build-report.js
reports/report.html        // generated, committed
reports/REPORT.md          // hand-written, committed
```

### Files modified

```text
src/main.js      // JSON telemetry + monitorEventLoopDelay
package.json     // autocannon devDependency, bench:a / bench:b / report scripts
.gitignore       // reports/raw/
```

Timestamps everywhere: epoch ms from the host clock, except telemetry `t`, which comes from the container clock. Both share the host kernel clock, so no skew correction.

---

## Implementation plan

1. **Switch telemetry to JSON lines in `src/main.js`.** Create a `monitorEventLoopDelay({ resolution: 10 })` histogram, enable it at boot. Each interval emit the telemetry object from the data model, then `histogram.reset()`. Startup log becomes the `startup` JSON line. Manual test: `npm start | head -3` prints three parseable JSON lines.

2. **Add `Dockerfile` and `.dockerignore`.** `node:22-alpine`, copy `package*.json`, `npm ci --omit=dev`, copy `src/`, `CMD ["node", "src/main.js"]`. `.dockerignore` excludes `node_modules`, `reports`, `bench`, `specs`, `.git`. Manual test: `docker build -t eqa-mvp .` succeeds.

3. **Add `docker-compose.yml`.** Service `eqa`, builds from `.`, `cpus: 1`, `mem_limit: 512m`, publishes `3000:3000`, forwards every SPEC 01 env var as `${KEY:-default}`. Manual test: `docker compose up -d`, `curl localhost:3000/health` returns ok, `docker stats` shows the 512MiB limit.

4. **Add `bench/scenario-a.env` and `bench/scenario-b.env`.** Contents as in the data model. Manual test: `docker compose --env-file bench/scenario-b.env up -d`, startup log line shows `payloadSizeMb: 200`.

5. **Add `autocannon` devDependency and `.gitignore` entry.** `npm i -D autocannon`, append `reports/raw/` to `.gitignore`. Manual test: `npx autocannon --version` works.

6. **Implement `bench/health-probe.js`.** Exports `startProbe({ url, intervalMs })` returning `{ stop() }`; `stop()` resolves with `{ startedAt, samples }`. Uses global `fetch` with a 5s `AbortSignal.timeout`; network error records `status: null`. Runnable standalone for a quick check. Manual test: against a running container, 5 seconds of probing yields ~50 samples.

7. **Implement `bench/run-scenario.js`.** Parse `A|B` from argv, look up `SCENARIOS`. For Scenario A, read the soft limit via `ulimit -n` and abort with a clear message if below 4096. Sequence: `docker compose --env-file <file> up -d --build`, poll `/health` until 200 (30s cap), start probe, run autocannon programmatically with `setupRequest` rotating ids, stop probe when autocannon finishes, write `reports/raw/scenario-<x>.autocannon.json` and `.probe.json`, run `docker compose logs --no-log-prefix eqa`, keep lines starting with `{`, write `.telemetry.jsonl`, capture `docker compose ps -a --format json` into `.container.json` (exit code and state), `docker compose down`. `down` runs in a `finally`. Print a one-screen summary (requests, errors, timeouts, non-2xx, probe p99, max heap, max lag p99, ulimit used). Manual test: `node bench/run-scenario.js A` completes and four raw files exist.

8. **Add npm scripts.** `bench:a`, `bench:b`, `report` in `package.json`. Manual test: `npm run bench:a` equals step 7.

9. **Implement `bench/build-report.js`.** Read raw files for each scenario present. Render `reports/report.html`: per scenario a headline table (total requests, errors, timeouts, non-2xx, probe p99, max `heapUsedMb`, max `rssMb`, max `lagP99Ms`, pass/fail per gated metric) and four Chart.js line charts over time (lag p99, heap, RSS, `/health` latency). Data embedded inline as JSON; Chart.js loaded from `cdn.jsdelivr.net`. Missing scenario renders "not run". Manual test: `npm run report`, open file, charts render.

10. **Run both scenarios and write `reports/REPORT.md`.** Execute `npm run bench:a`, `npm run bench:b`, `npm run report`. Write `REPORT.md`: environment (host CPU, load average, Docker and Compose versions, `ulimit -n`, container limits), per-scenario verdict against the acceptance thresholds, headline numbers, link to `report.html`, the three deviations from the source plan. Commit `report.html` and `REPORT.md`.

---

## Acceptance criteria

### Infrastructure

- [ ] `docker compose up -d --build` starts the `eqa` service; `docker inspect` reports `NanoCpus=1000000000` and `Memory=536870912`.
- [ ] Every stdout line from the container parses as JSON with a `type` of `startup` or `telemetry`.
- [ ] Telemetry lines contain all nine fields from the data model, one line per second.
- [ ] `node src/main.js` without Docker still starts and serves `GET /health`.
- [ ] `git status` after a bench run shows no files under `reports/raw/`.

### Scenario A — extreme concurrency

- [ ] `npm run bench:a` finishes without manual intervention and leaves no running container.
- [ ] Autocannon reports `errors = 0`, `timeouts = 0`, `non2xx = 0`.
- [ ] Every probe sample has `status: 200`.
- [ ] Probe `/health` latency p99 < 50ms.
- [ ] Telemetry `lagP99Ms` never exceeds 50ms during the run.
- [ ] Telemetry `db2PeakInFlight` exceeds 30, confirming the cap was lifted.

### Scenario B — massive streaming

- [ ] `npm run bench:b` finishes without manual intervention and leaves no running container.
- [ ] All 50 requests return `200`; autocannon `errors = 0`, `timeouts = 0`.
- [ ] Telemetry `heapUsedMb` never exceeds 100.
- [ ] Container is never OOMKilled: telemetry shows no gap longer than 3s between consecutive lines.
- [ ] Probe `/health` latency p99 is recorded and shown in the report (not gated).

### Report

- [ ] `npm run report` writes `reports/report.html` from existing raw files.
- [ ] Opening `report.html` in a browser renders four charts per scenario and a headline table with a pass/fail per gated metric.
- [ ] `reports/REPORT.md` states environment, per-scenario verdict, headline numbers, and the three deviations from the source plan.

---

## Decisions

- **Yes:** Scenario A with `DB2_MAX_CONCURRENCY=2000`. The question is whether the event loop blocks; the mock pool at 30 would queue requests for minutes and turn timeouts into a pool-sizing artifact.
- **No:** Keeping the cap at 30 with a 600s client timeout. Measures the mock semaphore, not Node.
- **Yes:** Scenario A with `PAYLOAD_SIZE_MB=1`. At 100MB, 2,000 requests move 200GB through one core — CPU-bound, wrong test.
- **Yes:** SPEC 01 latencies unchanged (7.5–9.5s per request). The MVP stays as approved; the report states the deviation from the doc's ~5s.
- **Yes:** Scenario B heap gate at 100MB, per the source doc. Stricter than SPEC 01's 150MB.
- **Yes:** `autocannon` as npm devDependency, driven programmatically. Same toolchain, JSON results, `setupRequest` for id rotation.
- **No:** k6. Extra binary, second scripting language.
- **Yes:** Load generator on the host, outside the container. Keeps it from competing for the one CPU under measurement.
- **No:** Load generator as a second compose service. Adds network hop and shared-host noise for no gain.
- **Yes:** `docker-compose.yml` with `cpus: 1` and `mem_limit: 512m`. Limits are versioned, not tribal knowledge in a shell command.
- **Yes:** `node:22-alpine`. Current LTS, small image, satisfies `engines >=20`.
- **Yes:** `perf_hooks.monitorEventLoopDelay` inside the MVP as the lag source. Works in Docker, zero dependencies, numeric output for gating.
- **No:** Clinic.js Doctor. Flaky on Node 20+, needs volume plumbing to extract HTML, adds overhead to the thing measured, and yields a picture rather than a gate.
- **Yes:** JSON lines on stdout, captured with `docker compose logs`. One format for humans and the report script; no log files inside the container.
- **No:** Keeping the text line alongside JSON. Two formats for one signal. Supersedes SPEC 01's `Heap Used: NN MB` acceptance criterion.
- **Yes:** `/health` gated on p99, not max. A single GC pause breaking the max is noise, not blocking.
- **Yes:** Scenario B `/health` latency recorded but not gated. Generating 10GB on one core is CPU work; a lag spike there is not I/O blocking, and the source doc gates only heap for B.
- **Yes:** Scenario A lag gate at `lagP99Ms ≤ 50ms`. 10ms histogram resolution puts idle baseline near 10ms; "close to 0" is not measurable.
- **Yes:** One orchestrator script per scenario. A run is one command and reproducible; `compose down` in `finally` prevents orphaned containers.
- **Yes:** Env files per scenario via `--env-file`. Scenario config is data, visible in the repo.
- **Yes:** Unique study id per in-flight request (`SEED_SIZE=2000`, rotation via `setupRequest`). Avoids concurrent transitions on one id muddying results.
- **Yes:** OOMKill detection via telemetry gaps >3s, disambiguated by container state captured before `down`. Works without depending on `docker inspect` timing after removal.
- **Yes:** Generated `report.html` with Chart.js from CDN, plus hand-written `REPORT.md`. HTML carries the evidence; Markdown carries the verdict readable on GitHub.
- **Yes:** `reports/raw/` gitignored. Raw data is large and reproducible; only the final report is committed.
- **Yes:** One run per scenario. MVP evidence; repetition deferred.
- **No:** Worst-of-3 aggregation. Deferred to a future spec if variance becomes a question.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Host `ulimit -n` (often 1024) caps autocannon below 2,000 sockets; failures look like server errors | `run-scenario.js` reads the soft limit at start and aborts Scenario A with a clear message if below 4096. The summary and `REPORT.md` record the value used. |
| Docker userland proxy on the published port becomes the bottleneck at 2,000 connections | Report records Docker version and proxy mode. If A fails with host-side resets but telemetry lag stays flat, the verdict notes the proxy, not Node. |
| A blocked event loop also delays the telemetry interval, so a >3s gap could mean blocking, not OOMKill | Both are failures. The report shows the last telemetry line before the gap; `.container.json`, captured before `down`, gives the exit reason that distinguishes them. |
| Autocannon stops at 30s with requests still in flight; those are neither success nor error | Expected. Report shows the completed-request count. |
| Chart.js CDN unreachable when opening `report.html` offline | Headline table is plain HTML and readable without charts. `REPORT.md` carries the verdict independently. |
| Node heap sizing ignores the 512MB cgroup limit and grows unchecked before GC | Node 22 derives default heap limits from cgroup memory. Gate is on observed `heapUsedMb`, so a miss fails loudly. |
| `docker compose` v1 (`docker-compose`) on the host | Orchestrator invokes `docker compose` v2 only; `REPORT.md` environment section lists the version. |
| Host is noisy (other workloads) and skews one-shot numbers | Single run by decision. `REPORT.md` records host CPU model and load average at start. |

---

## What is **not** in this spec

- Clinic.js Doctor profiling and k6.
- Repeated runs or statistical aggregation.
- Tuning SPEC 01 latencies or any change to domain, ports, use case, or adapters.
- A DB2-cap-at-30 pool-sizing scenario.
- OpenShift deployment, Kubernetes manifests, probes.
- CI integration of the benchmark.
- Automated test suite.

Each one of those, if it lands, goes in its own spec.
