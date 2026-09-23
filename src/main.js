import express from 'express';
import config from './config.js';
import { MockDB2Repository } from './infrastructure/adapters/MockDB2Repository.js';
import { MockT2T18Client } from './infrastructure/adapters/MockT2T18Client.js';
import { S3StreamStorage } from './infrastructure/adapters/S3StreamStorage.js';
import { ProcessStudyUseCase } from './application/use-cases/ProcessStudyUseCase.js';
import { createStudyRouter } from './infrastructure/web/ExpressController.js';
import { MockStateStore } from './infrastructure/adapters/MockStateStore.js';
import { MockArtifactStorage } from './infrastructure/adapters/MockArtifactStorage.js';
import { ProcessStudyLifecycleUseCase } from './application/use-cases/ProcessStudyLifecycleUseCase.js';
import { StartProcessingUseCase } from './application/use-cases/StartProcessingUseCase.js';
import { ReadyJarsUseCase } from './application/use-cases/ReadyJarsUseCase.js';
import { MarkCompleteUseCase } from './application/use-cases/MarkCompleteUseCase.js';
import { createAsyncProcessingRouter } from './infrastructure/web/AsyncProcessingController.js';
import { createDriverRouter } from './infrastructure/web/DriverController.js';

const BYTES_PER_MB = 1024 * 1024;
const payloadSize = config.payloadSizeMb * BYTES_PER_MB;

// Composition root: the only place that knows about config and concrete adapters.
const studyRepository = new MockDB2Repository({
  latencyMs: config.db2LatencyMs,
  maxConcurrency: config.db2MaxConcurrency,
  seedSize: config.seedSize,
  payloadSize,
});
const infoServiceClient = new MockT2T18Client({
  latencyMinMs: config.t2t18LatencyMinMs,
  latencyMaxMs: config.t2t18LatencyMaxMs,
  payloadSize,
  failureRate: config.failureRate,
});
const storageService = new S3StreamStorage();
const processStudyUseCase = new ProcessStudyUseCase(studyRepository, infoServiceClient, storageService);

// Async lifecycle (SPEC 01-A): STATE.JSON store plus artifact storage the driver can read back.
const stateStore = new MockStateStore();
const artifactStorage = new MockArtifactStorage();
const processStudyLifecycleUseCase = new ProcessStudyLifecycleUseCase(infoServiceClient, artifactStorage, stateStore);
const startProcessingUseCase = new StartProcessingUseCase(studyRepository, stateStore, processStudyLifecycleUseCase);
const readyJarsUseCase = new ReadyJarsUseCase(artifactStorage, stateStore);
const markCompleteUseCase = new MarkCompleteUseCase(stateStore);

const app = express();
app.use(createStudyRouter(processStudyUseCase));
app.use(createAsyncProcessingRouter(startProcessingUseCase));
app.use(createDriverRouter(readyJarsUseCase, markCompleteUseCase));

setInterval(() => {
  const heapUsedMb = Math.round(process.memoryUsage().heapUsed / BYTES_PER_MB);
  console.log(`Heap Used: ${heapUsedMb} MB`);
  console.log(`DB2 In-Flight: ${studyRepository.inFlight} (peak ${studyRepository.peakInFlight})`);
}, config.heapLogIntervalMs);

app.listen(config.port, () => {
  console.log(`eQA hexagonal MVP listening on port ${config.port}`, config);
});
