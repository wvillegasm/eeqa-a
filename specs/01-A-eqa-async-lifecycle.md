# SPEC 01-A — eQA Async Lifecycle Contract

> **Status:** Draft
> **Depends on:** SPEC 01, SPEC 02
> **Date:** 2026-09-23
> **Objective:** Define the API/state orchestration and transfer lifecycle required to implement the missing eQA processing flow, guaranteeing the asynchronous contract, state transitions, and verification path are explicit before code is written.

---

## Why this spec exists

The MVP in SPEC 01 proves the throughput shape and streaming behavior of the eQA system in isolation. It does not yet define the operational contract between the API and the driver flow described in the architecture document.

This spec closes that gap. It makes the lifecycle explicit and testable: which states exist, how the API exposes them, how the driver is permitted to fetch and confirm packages, and what must be true for the system to be accepted as implemented.

The purpose is not to add new production infrastructure. The purpose is to guarantee that the missing orchestration logic is specified before it is built.

---

## Scope

**In:**

- A single asynchronous processing lifecycle for an eQA study, with states `K`, `P`, `R`, `S`, `W`, `D`, and `E` as defined in the architecture specification.
- API endpoints required for lifecycle orchestration:
  - `POST /start-processing`
  - `GET /ready-jars`
  - `POST /mark-complete`
  - `GET /health`
- A durable working-state contract stored as `STATE.JSON` in a cloud working store, with explicit transitions and idempotency safeguards.
- Use-case orchestration that:
  - queries pending cases from the repository layer,
  - fetches SSN data from the info-service adapter,
  - streams generated artifact content to the working store,
  - flags the item as ready and then sent,
  - records completion only after confirmation from the driver.
- A driver-side polling agreement:
  - driver polls for ready artifacts,
  - receives the artifact stream,
  - writes it locally,
  - sends `mark-complete`,
  - final state is only marked as finished after disk persistence is confirmed.
- A mock persistence layer for `STATE.JSON` and working artifacts, intended to mirror the production contract without forcing real AWS or DB2 dependencies.
- One verification harness that exercises the full mock flow end-to-end and proves the state transitions fire in the correct order.

**Not in:**

- Real IBM DB2, T2/T16, S3, or Windows-driver implementations.
- Real production `SSN`/`Sample` hierarchy or the full enterprise status matrix beyond the lifecycle states above.
- Deployment manifests, Docker, OpenShift config, or production infra tuning.
- Performance benchmarking or memory/cpu profiling beyond the verification path needed to prove the lifecycle works.
- Authentication, RBAC, logs, monitoring stack, and operational dashboards.
- Any change to the MVP domain language from SPEC 01 beyond the architecture-required lifecycle states.
- Any new work outside the API lifecycle and transfer lifecycle.

---

## Data model

### Lifecycle state contract

The transport contract for the asynchronous run is a normalized object stored in a `STATE.JSON` document and managed by the working-store adapter. This document is the source of truth for each case or study during the lifecycle.

```json
{
  "studyId": "study-123",
  "batchId": "batch-abc",
  "ssn": "123456789",
  "status": "K",
  "artifact": {
    "name": "study-123.jar",
    "path": "/studies/study-123/ssn/123456789/artifacts/study-123.jar",
    "sizeBytes": 1048576,
    "checksum": "sha256:..."
  },
  "history": [
    { "status": "K", "at": 1758650000000 },
    { "status": "P", "at": 1758650005000 }
  ],
  "updatedAt": 1758650005000
}
```

State meanings:

- `K`: initial state, pending in repository.
- `P`: processing started by API.
- `R`: artifact created and ready for streaming.
- `S`: sent to driver / in transfer.
- `W`: written to driver local storage and verified.
- `D`: done / terminal success.
- `E`: error / failed terminal state.

The state is persisted as a JSON document in the working-store adapter. The system must never rely on in-memory status alone. The lifecycle is explicit and retrievable.

### API request/response contract

```json
// POST /start-processing
{
  "batchId": "batch-abc",
  "sampleLimit": 40
}
```

Response:

```json
{
  "status": "ACCEPTED",
  "runId": "run-001",
  "acceptedAt": 1758650000000
}
```

```json
// GET /ready-jars?batchId=batch-abc
```

Response: binary stream of the artifact file, with the working-store state changed to `S` before or during streaming.

```json
// POST /mark-complete
{
  "runId": "run-001",
  "studyId": "study-123",
  "ssn": "123456789",
  "status": "W"
}
```

Response:

```json
{
  "status": "ACK",
  "synced": true
}
```

### Port contracts

The implementation must preserve the hexagonal role boundaries already established in SPEC 01:

- `IStudyRepository`
  - `getPendingStudies()`
  - `getStudyById(id)`
  - `updateStudyStatus(studyId, status)`
- `IInfoServiceClient`
  - `fetchCaseData(ssn)`
  - `fetchStudyPayload(studyId)`
- `IStorageService`
  - `saveArtifact(studyId, ssn, stream)`
  - `getArtifact(studyId, ssn)`
  - `updateState(studyId, state, metadata)`
  - `getState(studyId)`

Any implementation that mixes infrastructure logic into the use case layer is out of scope.

### Files to be introduced or modified

```text
src/domain/entities/StudyState.js
src/domain/entities/RunState.js
src/application/use-cases/StartProcessingUseCase.js
src/application/use-cases/ReadyJarsUseCase.js
src/application/use-cases/MarkCompleteUseCase.js
src/application/use-cases/ProcessStudyLifecycleUseCase.js
src/infrastructure/adapters/MockStateStore.js
src/infrastructure/adapters/MockDriverGateway.js
src/infrastructure/web/AsyncProcessingController.js
src/infrastructure/web/DriverController.js
```

This spec does not mandate the exact names of every file beyond the required behavior; the key requirement is that state lifecycle, API contract, and driver flow are separated cleanly.

---

## Implementation plan

1. **Create the lifecycle state model.**
   Add a small domain object for the lifecycle state, with explicit transitions between `K`, `P`, `R`, `S`, `W`, `D`, and `E`. This must be a pure domain model and must not know anything about HTTP, streams, or database adapters.

2. **Add a mock working-state store.**
   Implement a mock adapter that stores `STATE.JSON` in memory and exposes:
   - `createOrUpdateState(studyId, patch)`
   - `getState(studyId)`
   - `markReady(studyId, artifactMeta)`
   - `markSent(studyId)`
   - `markWritten(studyId)`
   - `markDone(studyId)`
   - `markError(studyId, reason)`

   This keeps the contract visible while avoiding a production AWS dependency.

3. **Add the start-processing use case.**
   `StartProcessingUseCase` must:
   - read pending records from the repository,
   - create a run context,
   - persist the initial state as `P`,
   - return `202 Accepted` semantics from the controller layer,
   - never block the caller with long synchronous work.

4. **Add the ready-artifact use case.**
   `ReadyJarsUseCase` must:
   - read the state for a given `studyId`,
   - confirm it is in `R`,
   - retrieve the artifact stream from storage,
   - stream it to the HTTP caller without loading it fully into memory,
   - update the state to `S` at the start of the transfer.

5. **Add the completion acknowledgement use case.**
   `MarkCompleteUseCase` must:
   - accept the driver confirmation payload,
   - check that the artifact has actually been written,
   - transition the state from `S` to `W`,
   - complete to `D` only when the final post-write validation passes,
   - move to `E` on failed confirmation or write errors.

6. **Add the API controller layer.**
   Build the HTTP layer with four routes:
   - `POST /start-processing`
   - `GET /ready-jars`
   - `POST /mark-complete`
   - `GET /health`

   The controller must hand off to use cases and must not contain business logic itself.

7. **Add the driver-side contract flow in a mock gateway.**
   The driver flow is intentionally simulated but must respect the production contract:
   - request start,
   - poll for ready artifacts,
   - fetch artifact stream,
   - write it locally,
   - call `POST /mark-complete`,
   - receive success or error,
   - update state accordingly.

8. **Add end-to-end verification against the mocked lifecycle.**
   Write a test or script that performs the sequence:
   - `start-processing`
   - `ready-jars`
   - local write
   - `mark-complete`
   - final state assertion

   The test must verify:
   - state order is `K -> P -> R -> S -> W -> D`
   - `GET /health` remains `200` during the flow
   - failed confirmation moves to `E`
   - duplicates or repeated completion do not corrupt the final state

9. **Keep SPEC 01 and SPEC 02 valid.**
   Nothing in this implementation may change the hexagonal MVP measurement contract or the benchmark plan. This is a lifecycle-implementation spec only; it fills the missing orchestration gap without altering the measurement design.

---

## Acceptance criteria

- [ ] `POST /start-processing` accepts a valid batch payload and responds `202` with a `runId`.
- [ ] A valid run creates a persistent `STATE.JSON` entry with status `P` before any artifact is streamed.
- [ ] `GET /ready-jars` returns a valid artifact stream only when the state is `R` or a valid ready condition exists.
- [ ] The transfer path transitions state from `R` to `S` when the artifact begins streaming.
- [ ] `POST /mark-complete` with a valid write confirmation transitions the state through `W` and then `D`.
- [ ] A failed or missing write confirmation leaves the record in `E` and does not incorrectly mark it as complete.
- [ ] Repeated `mark-complete` calls are idempotent: they do not corrupt or re-open a finished state.
- [ ] `GET /health` always returns `200 {"status":"ok"}` even while the lifecycle run is active.
- [ ] The state history contains the ordered lifecycle: `K`, `P`, `R`, `S`, `W`, `D` for the successful path.
- [ ] The API and driver flow are kept in distinct layers: controller calls use case, use case calls ports, and ports are implemented by adapters.
- [ ] No logic that belongs to infrastructure or the storage layer lives in the controller or domain model.
- [ ] The mock implementation mirrors the production contract enough to exercise the entire lifecycle end-to-end without real AWS or DB2 dependencies.

---

## Decisions taken and discarded

### Taken

- **Yes:** keep the state contract explicit and durable at the JSON level. The architecture document names the lifecycle and the repository needs a concrete, inspectable contract.
- **Yes:** use the mock working-state store to simulate `STATE.JSON` without bringing in AWS.
- **Yes:** keep controller, use case, and adapter boundaries separate.
- **Yes:** have the driver flow be a mock but contract-valid sequence, not an implicit side effect.
- **Yes:** enforce idempotency on the completion signal.
- **Yes:** the API layer remains non-blocking and returns `202` on start, because the architecture requires an asynchronous workflow.
- **Yes:** verify the lifecycle by a real end-to-end mocked flow, not just unit tests.

### Discarded

- **No:** real DB2/T2T16/S3 implementation in this spec.
- **No:** production deployment config in this spec.
- **No:** performance benchmarking in this spec.
- **No:** mixing driver logic and HTTP controller logic in one layer.
- **No:** implicit state mutation via ad hoc variables; the JSON state object is the source of truth.

---

## Identified risks

- **State drift between repository and working store.**
  Mitigation: the flow always reads from the working-state store as the system-of-record for lifecycle transitions, and the repository remains a source for pending records only.

- **Duplicate completion calls.**
  Mitigation: `mark-complete` is idempotent and checks the current state before moving to `W` or `D`.

- **A driver writes locally but the API never receives the acknowledgement.**
  Mitigation: the flow requires an explicit `mark-complete` call; without it, the record remains `S` or `E` instead of being marked complete.

- **Error states become ambiguous.**
  Mitigation: the failure path is explicit and terminal (`E`), with the history retaining the final error reason.

- **Controllers drift into business logic.**
  Mitigation: the controller only translates HTTP to use case calls and returns serialized contracts.

---

## What is not in this spec

- Real DB2, T2T16, S3, or driver implementations.
- Performance or benchmark scenarios.
- Real production deployment or container definitions.
- Any domain or architecture change beyond the explicit API and state lifecycle required by the architecture document.

Each one of those, if it lands, goes in its own spec.
