# SPEC 01 — Hexagonal MVP for Non-Blocking Study Processing

> **Status:** Implemented
> **Depends on:** None
> **Date:** 2026-09-22
> **Objective:** Build a hexagonal-architecture Node.js MVP that processes a study through mocked DB2, T2T18 and S3 adapters using streams, proving the event loop never blocks under heavy I/O.

---

## Why this spec exists

The team fears that Node.js will block under the eQA workload and that streaming 100MB+ payloads to S3 will saturate a 512MB container. Those fears are architectural claims, not measurements.

This MVP exists to make them measurable. It reproduces the shape of the real `eqa-api` — slow DB2 queries, slow T2T18 fetches, giant payloads to S3 — with every external system mocked. The hexagonal layering is not decoration: it is what lets the mocks be swapped for real adapters later without touching the use case.

The measurement campaign itself is **not** here. It is SPEC 02.

---

## Scope

**In:**

- Domain entity `Study` with pure state transitions.
- Use case `ProcessStudyUseCase` orchestrating the three ports.
- Three port contracts: `IStudyRepository`, `IInfoServiceClient`, `IStorageService`.
- Three mock adapters simulating DB2 latency, T2T18 streaming latency, and S3 stream consumption.
- Express controller exposing `POST /api/v1/studies/:id/process` and `GET /health`.
- Composition root in `src/main.js` with dependency injection.
- Heap-usage logger on a 1-second interval.
- Runtime tuning through environment variables (latencies, payload size, failure rate, concurrency cap, port).

**Out of scope (for future specs):**

- Docker image and container resource limits — SPEC 02.
- Autocannon / k6 load scenarios and Clinic.js profiling — SPEC 02.
- The final measurement report — SPEC 02.
- Real DB2, T2T18 and AWS S3 adapters.
- The `Study 1:N Sample 1:N SSN` hierarchy and the `P/G/C/E/I/K/N` status codes from the architecture document.
- The `/start`, `/finished-work`, `/transferred` run-orchestration endpoints.
- The Windows Driver daemon and NFS materialization.
- Automated test suite.
- Structured logging libraries, authentication, persistence beyond process memory.

---

## Data model

### `Study` entity

```js
// src/domain/entities/Study.js
class Study {
  id; // string
  ssn; // string
  status; // 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR'
  payloadSize; // number — bytes
}
```

Transitions are pure methods that mutate only `status`: `markAsProcessing()`, `markAsCompleted()`, `markAsError()`.

Status values live in an exported frozen object `StudyStatus`. No status letters from the architecture document — this MVP uses the four words above and nothing else.

### Repository seed

`MockDB2Repository` holds an in-memory `Map<string, Study>` seeded at construction. Seed size is fixed at construction time; ids are `study-1` … `study-N`, ssn values are synthetic zero-padded digits. `updateStudyStatus(study)` writes back into the `Map`, so a subsequent `getStudyById` observes the new status.

### Configuration

Read once in the composition root, never read from `process.env` deeper in the tree.

```js
// src/config.js — defaults shown
{
  port: 3000,                  // PORT
  db2LatencyMs: 1500,          // DB2_LATENCY_MS
  db2MaxConcurrency: 30,       // DB2_MAX_CONCURRENCY
  t2t18LatencyMinMs: 3000,     // T2T18_LATENCY_MIN_MS
  t2t18LatencyMaxMs: 5000,     // T2T18_LATENCY_MAX_MS
  payloadSizeMb: 100,          // PAYLOAD_SIZE_MB
  failureRate: 0,              // FAILURE_RATE — 0..1
  seedSize: 1000,              // SEED_SIZE
  heapLogIntervalMs: 1000,     // HEAP_LOG_INTERVAL_MS
}
```

### Files created

```text
package.json
src/config.js
src/domain/entities/Study.js
src/ports/NotImplementedError.js
src/ports/IStudyRepository.js
src/ports/IInfoServiceClient.js
src/ports/IStorageService.js
src/application/use-cases/ProcessStudyUseCase.js
src/infrastructure/adapters/MockDB2Repository.js
src/infrastructure/adapters/MockT2T18Client.js
src/infrastructure/adapters/S3StreamStorage.js
src/infrastructure/web/ExpressController.js
src/main.js
```

Conventions: plain JavaScript with JSDoc type annotations, ES modules (`"type": "module"`), Node 20+, npm. Single runtime dependency: `express`. Logging via `console`.

---

## Implementation plan

1. **Create `package.json`.** Set `"type": "module"`, `"engines": { "node": ">=20" }`, script `"start": "node src/main.js"`, dependency `express`. Manual test: `npm install` completes.

2. **Create `src/config.js`.** Export a frozen config object reading the environment variables listed in the data model, applying the defaults. Manual test: `node -e "import('./src/config.js').then(m => console.log(m.default))"` prints the defaults.

3. **Implement `src/domain/entities/Study.js`.** Export `StudyStatus` and the `Study` class with a constructor and the three transition methods. No I/O, no imports. Manual test: construct one in the REPL, call `markAsProcessing()`, read `status`.

4. **Implement the ports.** `src/ports/NotImplementedError.js` exports an `Error` subclass. The three port files export base classes whose every method throws it. Manual test: instantiate a port, call a method, observe the throw.

5. **Implement `src/infrastructure/adapters/MockDB2Repository.js`.** Includes a private `Semaphore` class in the same file capping concurrent calls at `db2MaxConcurrency`. Both `getStudyById` and `updateStudyStatus` acquire the semaphore and await `db2LatencyMs` before touching the seeded `Map`. Manual test: a short script fires 100 concurrent `getStudyById` calls, logs in-flight count, observes it never exceeds 30.

6. **Implement `src/infrastructure/adapters/MockT2T18Client.js`.** `fetchT2T18Data(ssn)` waits a random delay between `t2t18LatencyMinMs` and `t2t18LatencyMaxMs`, rolls `failureRate` and throws on a hit, then returns a `stream.Readable` that generates chunks on the fly until `payloadSizeMb` is emitted. Chunks are produced inside `_read`, never precomputed. Manual test: consume the stream to a counter, verify byte total matches and heap stays flat.

7. **Implement `src/infrastructure/adapters/S3StreamStorage.js`.** `uploadStream(filename, readableStream)` pipes the source through a `stream.PassThrough` into a write stream on `/dev/null` using `stream/promises.pipeline`, resolving when the pipeline settles. Manual test: pipe the T2T18 mock stream into it, confirm it resolves and heap stays flat.

8. **Implement `src/application/use-cases/ProcessStudyUseCase.js`.** Constructor injects the three ports. `execute(studyId)` fetches the study, marks it `PROCESSING` and persists, fetches the T2T18 stream, uploads it, marks `COMPLETED` and persists. A `try/catch` around the body marks `ERROR`, persists, and rethrows. Manual test: run it against fake in-line ports, assert both the happy and the failing path.

9. **Implement `src/infrastructure/web/ExpressController.js`.** Export a factory taking the use case and returning an Express router. `POST /api/v1/studies/:id/process` awaits `execute` and responds `200` with the final study state; on throw it responds `500` with the error message. `GET /health` responds `200` with `{ status: 'ok' }` and performs no I/O.

10. **Implement `src/main.js`.** Instantiate the config, the three adapters and the use case, mount the router on an Express app, start the heap logger interval, listen on `config.port`. Manual test: `npm start`, then `curl localhost:3000/health` returns `ok` and `curl -X POST localhost:3000/api/v1/studies/study-1/process` returns `COMPLETED` after roughly 5–8 seconds.

---

## Acceptance criteria

- [ ] `npm install && npm start` boots the server on port 3000 with no errors in the console.
- [ ] `GET /health` responds `200 {"status":"ok"}`.
- [ ] `POST /api/v1/studies/study-1/process` responds `200` and the body reports `status: "COMPLETED"`.
- [ ] That request takes at least 4.5 seconds, confirming the injected latencies are applied.
- [ ] `POST /api/v1/studies/does-not-exist/process` responds `500` and does not crash the process.
- [ ] After a failed run with `FAILURE_RATE=1`, a follow-up `getStudyById` for that id reports `status: "ERROR"`.
- [ ] The heap logger prints a `Heap Used: NN MB` line every second while the server runs.
- [ ] With 100 concurrent `POST` requests in flight, an instrumented counter in `MockDB2Repository` never reports more than 30 concurrent calls.
- [ ] With 10 concurrent `POST` requests at `PAYLOAD_SIZE_MB=200`, logged `heapUsed` stays below 150MB for the whole run.
- [ ] While those 10 requests are in flight, `GET /health` still responds in under 50ms.
- [ ] `src/application/` and `src/domain/` contain no `import` of `express`, `stream`, or any file under `src/infrastructure/`.
- [ ] Instantiating any class in `src/ports/` and calling one of its methods throws `NotImplementedError`.

---

## Decisions

- **Yes:** Plain JavaScript with JSDoc types. No build step, so `node src/main.js` runs directly and Clinic.js profiles real source lines in SPEC 02.
- **No:** TypeScript. The transpile step adds sourcemap friction to profiling for no gain at MVP size.
- **Yes:** ES modules with `"type": "module"`. Current Node default posture.
- **Yes:** Code at repository root. This repository is the MVP; a nested folder would add a path level for nothing.
- **Yes:** Flat `Study { id, ssn, status, payloadSize }` with four word statuses. The MVP proves I/O behavior; the domain hierarchy contributes nothing to that proof.
- **No:** The `Study 1:N Sample 1:N SSN` hierarchy and `P/G/C/E/I/K/N` codes from the architecture document. Real system shape, wrong tool for this question. Belongs to the production implementation.
- **Yes:** The endpoint awaits the use case and returns `200`. Scenario A in SPEC 02 rests on each request occupying ~5 seconds; that only holds if the request stays open.
- **No:** `202 Accepted` with background processing. It would return in about a millisecond and measure nothing.
- **Yes:** In-memory `Map` seeded at construction. Gives `updateStudyStatus` a real destination, so status transitions are observable after the fact.
- **Yes:** Payload size, latencies, failure rate and concurrency cap all come from environment variables. SPEC 02's Scenario B becomes a flag instead of a source edit.
- **Yes:** `PassThrough` into `/dev/null`. 10 concurrent 200MB streams hitting a temp file would turn a memory test into a disk-throughput test.
- **No:** Temp files under `os.tmpdir()`. Same reason.
- **Yes:** Semaphore lives inside `MockDB2Repository` and guards both its methods. It models the DB2 connection pool specifically; T2T18 and S3 have no equivalent cap in the real system.
- **No:** A semaphore shared across all three adapters. It would throttle the very concurrency the MVP is meant to demonstrate.
- **Yes:** `FAILURE_RATE` defaulting to `0`, injected in the T2T18 mock. The `ERROR` branch is otherwise dead code that no acceptance criterion could assert.
- **Yes:** Heap logger lives in `src/main.js`. It is MVP source; SPEC 02 only reads what it emits.
- **Yes:** `console` for logging, `express` as the single runtime dependency. Fewer moving parts between the measurement and the thing measured.
- **No:** Automated test suite. Verification here is `curl` plus the SPEC 02 load campaign, which is the actual deliverable.
- **Note:** Sections 1 through 7 of this document were written in a single pass at the user's request, after the full clarification phase was completed.

---

## Risks

| Risk                                                                                      | Mitigation                                                                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A mock resolves too fast and the measurement proves nothing                               | Acceptance criteria assert a floor on request duration, not just a successful response.                         |
| Chunk generation in `MockT2T18Client` precomputes the payload and defeats the memory test | Chunks are generated inside `_read`. The 200MB heap criterion fails loudly if this regresses.                   |
| `/dev/null` is unavailable on non-POSIX hosts                                             | The MVP targets Linux containers, matching the OpenShift target. Windows developers run it under Docker or WSL. |
| Domain or application layers acquire an infrastructure import over time                   | An acceptance criterion forbids those imports explicitly.                                                       |
| The semaphore deadlocks if a release is skipped on a throwing path                        | Release goes in a `finally` block; the 100-concurrent-request criterion surfaces a stall.                       |

---

## What is **not** in this spec

- Docker image, container limits, Autocannon, k6, Clinic.js, and the measurement report — all SPEC 02.
- Real DB2, T2T18 and S3 adapters.
- The `Sample` and `SSN` entities and the seven-letter status machine.
- The `/start`, `/finished-work` and `/transferred` endpoints, the Windows Driver, and NFS writing.
- Automated tests, authentication, structured logging, durable persistence.

Each one of those, if it lands, goes in its own spec.
