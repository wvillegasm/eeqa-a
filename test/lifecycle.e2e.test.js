import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { MockDB2Repository } from '../src/infrastructure/adapters/MockDB2Repository.js';
import { MockT2T18Client } from '../src/infrastructure/adapters/MockT2T18Client.js';
import { S3StreamStorage } from '../src/infrastructure/adapters/S3StreamStorage.js';
import { MockStateStore } from '../src/infrastructure/adapters/MockStateStore.js';
import { MockArtifactStorage } from '../src/infrastructure/adapters/MockArtifactStorage.js';
import { MockDriverGateway } from '../src/infrastructure/adapters/MockDriverGateway.js';
import { ProcessStudyUseCase } from '../src/application/use-cases/ProcessStudyUseCase.js';
import { ProcessStudyLifecycleUseCase } from '../src/application/use-cases/ProcessStudyLifecycleUseCase.js';
import { StartProcessingUseCase } from '../src/application/use-cases/StartProcessingUseCase.js';
import { ReadyJarsUseCase } from '../src/application/use-cases/ReadyJarsUseCase.js';
import { MarkCompleteUseCase } from '../src/application/use-cases/MarkCompleteUseCase.js';
import { createStudyRouter } from '../src/infrastructure/web/ExpressController.js';
import { createAsyncProcessingRouter } from '../src/infrastructure/web/AsyncProcessingController.js';
import { createDriverRouter } from '../src/infrastructure/web/DriverController.js';

const PAYLOAD_SIZE = 1024 * 1024;
const SUCCESS_PATH = ['K', 'P', 'R', 'S', 'W', 'D'];

/**
 * Test composition root: same wiring as main.js, with fast mocks, temp dirs
 * and an ephemeral port.
 */
async function startServer() {
  const tempDir = await mkdtemp(join(tmpdir(), 'eqa-e2e-'));
  const studyRepository = new MockDB2Repository({
    latencyMs: 20,
    maxConcurrency: 10,
    seedSize: 10,
    payloadSize: PAYLOAD_SIZE,
  });
  // Slow enough that P is observable before R.
  const infoServiceClient = new MockT2T18Client({
    latencyMinMs: 150,
    latencyMaxMs: 200,
    payloadSize: PAYLOAD_SIZE,
    failureRate: 0,
  });
  const stateStore = new MockStateStore();
  const artifactStorage = new MockArtifactStorage({ rootDir: join(tempDir, 'store') });

  const processStudyUseCase = new ProcessStudyUseCase(studyRepository, infoServiceClient, new S3StreamStorage());
  const lifecycle = new ProcessStudyLifecycleUseCase(infoServiceClient, artifactStorage, stateStore);
  const startProcessing = new StartProcessingUseCase(studyRepository, stateStore, lifecycle);
  const readyJars = new ReadyJarsUseCase(artifactStorage, stateStore);
  const markComplete = new MarkCompleteUseCase(stateStore);

  const app = express();
  app.use(createStudyRouter(processStudyUseCase));
  app.use(createAsyncProcessingRouter(startProcessing));
  app.use(createDriverRouter(readyJars, markComplete));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl, stateStore, tempDir };
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {unknown} payload
 */
function postJson(baseUrl, path, payload) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Polls /health until `stop()` is called; records every status and body.
 *
 * @param {string} baseUrl
 */
function watchHealth(baseUrl) {
  let running = true;
  /** @type {Array<{ status: number, body: unknown }>} */
  const samples = [];
  const done = (async () => {
    while (running) {
      const res = await fetch(`${baseUrl}/health`);
      samples.push({ status: res.status, body: await res.json() });
      await sleep(10);
    }
  })();
  return {
    samples,
    async stop() {
      running = false;
      await done;
    },
  };
}

/**
 * @param {MockStateStore} stateStore
 * @param {string} studyId
 */
async function historyOf(stateStore, studyId) {
  const state = await stateStore.getState(studyId);
  return state.history.map((entry) => entry.status);
}

describe('eQA async lifecycle, end to end over HTTP', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let ctx;

  before(async () => {
    ctx = await startServer();
  });

  after(async () => {
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
    await rm(ctx.tempDir, { recursive: true, force: true });
  });

  test('start answers 202 with a runId and persists P before anything is streamed', async () => {
    const res = await postJson(ctx.baseUrl, '/start-processing', { batchId: 'batch-p', sampleLimit: 1 });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, 'ACCEPTED');
    assert.match(body.runId, /^run-/);
    assert.equal(typeof body.acceptedAt, 'number');

    // Claiming happens in the background; wait for the P document.
    let state = null;
    for (let i = 0; i < 50 && !state; i++) {
      [state] = await ctx.stateStore.findByBatch('batch-p', 'P');
      if (!state) await sleep(10);
    }
    assert.ok(state, 'expected a STATE.JSON document in P');
    assert.equal(state.runId, body.runId);
    assert.deepEqual(state.history.map((entry) => entry.status), ['K', 'P']);

    // Nothing is ready yet, so there is nothing to stream.
    const ready = await fetch(`${ctx.baseUrl}/ready-jars?batchId=batch-p`);
    assert.equal(ready.status, 204);
  });

  test('driver flow runs K -> P -> R -> S -> W -> D while /health stays 200', async () => {
    const health = watchHealth(ctx.baseUrl);
    const driver = new MockDriverGateway({
      baseUrl: ctx.baseUrl,
      localDir: join(ctx.tempDir, 'driver-ok'),
      pollIntervalMs: 20,
      maxIdleMs: 2000,
    });

    const report = await driver.run({ batchId: 'batch-ok', sampleLimit: 3 });
    await health.stop();

    assert.equal(report.records.length, 3);
    for (const record of report.records) {
      assert.equal(record.status, 'D', `driver record for ${record.studyId}`);
      assert.deepEqual(await historyOf(ctx.stateStore, record.studyId), SUCCESS_PATH);
    }

    assert.ok(health.samples.length > 0, 'health was never sampled');
    for (const sample of health.samples) {
      assert.equal(sample.status, 200);
      assert.deepEqual(sample.body, { status: 'ok' });
    }
  });

  test('failed write confirmation moves the study to E and never to D', async () => {
    const driver = new MockDriverGateway({
      baseUrl: ctx.baseUrl,
      localDir: join(ctx.tempDir, 'driver-fail'),
      pollIntervalMs: 20,
      maxIdleMs: 2000,
      failWrite: () => true,
    });

    const report = await driver.run({ batchId: 'batch-fail', sampleLimit: 1 });

    assert.equal(report.records.length, 1);
    const [record] = report.records;
    assert.equal(record.status, 'E');
    const state = await ctx.stateStore.getState(record.studyId);
    assert.equal(state.status, 'E');
    assert.deepEqual(state.history.map((entry) => entry.status), ['K', 'P', 'R', 'S', 'E']);
    assert.match(state.history.at(-1).reason, /Driver reported status E/);
  });

  test('checksum mismatch after write moves the study through W to E', async () => {
    const start = await (await postJson(ctx.baseUrl, '/start-processing', { batchId: 'batch-bad', sampleLimit: 1 })).json();

    let res;
    for (let i = 0; i < 100; i++) {
      res = await fetch(`${ctx.baseUrl}/ready-jars?batchId=batch-bad`);
      if (res.status !== 204) break;
      await sleep(20);
    }
    assert.equal(res.status, 200);
    const studyId = res.headers.get('x-study-id');
    const ssn = res.headers.get('x-ssn');
    const bytes = Buffer.from(await res.arrayBuffer());

    const ack = await postJson(ctx.baseUrl, '/mark-complete', {
      runId: start.runId,
      studyId,
      ssn,
      status: 'W',
      checksum: 'sha256:not-the-real-one',
      sizeBytes: bytes.length,
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { status: 'ACK', synced: false });
    assert.deepEqual(await historyOf(ctx.stateStore, studyId), ['K', 'P', 'R', 'S', 'W', 'E']);
  });

  test('repeated and concurrent mark-complete calls do not corrupt a finished state', async () => {
    const driver = new MockDriverGateway({
      baseUrl: ctx.baseUrl,
      localDir: join(ctx.tempDir, 'driver-dup'),
      pollIntervalMs: 20,
      maxIdleMs: 2000,
    });
    const report = await driver.run({ batchId: 'batch-dup', sampleLimit: 1 });
    const [record] = report.records;
    assert.equal(record.status, 'D');
    const before = await ctx.stateStore.getState(record.studyId);

    const replays = [
      { status: 'W', checksum: before.artifact.checksum, sizeBytes: before.artifact.sizeBytes },
      { status: 'W', checksum: before.artifact.checksum, sizeBytes: before.artifact.sizeBytes },
      { status: 'E' },
      { status: 'W', checksum: 'sha256:wrong', sizeBytes: 1 },
    ];
    const answers = await Promise.all(
      replays.map((extra) =>
        postJson(ctx.baseUrl, '/mark-complete', {
          runId: report.runId,
          studyId: record.studyId,
          ssn: record.ssn,
          ...extra,
        }),
      ),
    );
    for (const answer of answers) {
      assert.equal(answer.status, 200);
      assert.deepEqual(await answer.json(), { status: 'ACK', synced: true });
    }

    assert.deepEqual(await ctx.stateStore.getState(record.studyId), before);
    assert.deepEqual(await historyOf(ctx.stateStore, record.studyId), SUCCESS_PATH);
  });
});
