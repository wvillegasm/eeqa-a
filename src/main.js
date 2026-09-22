import express from 'express';
import config from './config.js';
import { MockDB2Repository } from './infrastructure/adapters/MockDB2Repository.js';
import { MockT2T18Client } from './infrastructure/adapters/MockT2T18Client.js';
import { S3StreamStorage } from './infrastructure/adapters/S3StreamStorage.js';
import { ProcessStudyUseCase } from './application/use-cases/ProcessStudyUseCase.js';
import { createStudyRouter } from './infrastructure/web/ExpressController.js';

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

const app = express();
app.use(createStudyRouter(processStudyUseCase));

setInterval(() => {
  const heapUsedMb = Math.round(process.memoryUsage().heapUsed / BYTES_PER_MB);
  console.log(`Heap Used: ${heapUsedMb} MB`);
  console.log(`DB2 In-Flight: ${studyRepository.inFlight} (peak ${studyRepository.peakInFlight})`);
}, config.heapLogIntervalMs);

app.listen(config.port, () => {
  console.log(`eQA hexagonal MVP listening on port ${config.port}`, config);
});
