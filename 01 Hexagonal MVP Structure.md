## Specification Plan for AI Generator: Hexagonal MVP Structure

This document serves as a structured architectural prompt for an AI to generate the MVP codebase. The goal of this code is to simulate I/O-bound processing and heavy data stream management without blocking the Event Loop.

### 1. Domain Layer (`src/domain/`)

- **`entities/Study.js`**:
- Class representing the study extracted from DB2.
- Must include properties: `id`, `ssn`, `status` (values: `PENDING`, `PROCESSING`, `COMPLETED`, `ERROR`), `payloadSize`.
- Must contain pure methods for state transitions (`markAsProcessing()`, `markAsCompleted()`, `markAsError()`).

### 2. Application / Use Cases Layer (`src/application/`)

- **`use-cases/ProcessStudyUseCase.js`**:
- Inject three ports via constructor: `studyRepository`, `infoServiceClient`, `storageService`.
- **Asynchronous execution flow (`async execute(studyId)`):**

1. Call `studyRepository.getStudyById(studyId)`.
2. Call `infoServiceClient.fetchT2T18Data(study.ssn)`.
3. Initiate a stream to S3 by calling `storageService.uploadStream(studyId, dataStream)`.
4. Update the status to `COMPLETED` via `studyRepository.updateStudyStatus(study)`.

- Must include rigorous `try/catch` blocks that, in case of failure, update the status to `ERROR`.

### 3. Ports/Interfaces Layer (`src/ports/`)

- Define the contracts (base classes with methods throwing `NotImplementedError` or interfaces in JSDoc/TypeScript if typed):
- **`IStudyRepository`**: `getStudyById(id)`, `updateStudyStatus(study)`.
- **`IInfoServiceClient`**: `fetchT2T18Data(ssn)`.
- **`IStorageService`**: `uploadStream(filename, readableStream)`.

### 4. Infrastructure / Adapters Layer (`src/infrastructure/`)

- **`web/ExpressController.js`**:
- Handles the `POST /api/v1/studies/:id/process` route.
- Receives the request, invokes `ProcessStudyUseCase`, and immediately returns an HTTP 202 (Accepted) to delegate background processing (or HTTP 200 if awaiting resolution for the test).

- **`adapters/MockDB2Repository.js`**:
- Implements `IStudyRepository`.
- Uses `setTimeout` wrapped in Promises to simulate a 1.5-second network latency per query.
- **Pool Simulation:** Implement a basic semaphore limiting concurrent calls to a maximum of 30 (simulating DB2 restrictions).

- **`adapters/MockT2T18Client.js`**:
- Implements `IInfoServiceClient`.
- Simulates high asynchronous latency (3 to 5 seconds) by returning a readable stream generator (`stream.Readable`) that emits chunks of data generated on the fly.

- **`adapters/S3StreamStorage.js`**:
- Implements `IStorageService`.
- Instead of uploading to real AWS, it uses `stream.PassThrough` connected to `/dev/null` (or writing to a temporary local file) to consume the 100MB data stream, simulating bandwidth and guaranteeing data doesn't accumulate in RAM (`chunking`).

### 5. Dependency Injection (`src/main.js`)

- Entry point (`Composition Root`).
- Instantiates the simulated adapters, injects them into `ProcessStudyUseCase`, initializes Express, and starts the server on port 3000.
