import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * @typedef {Object} DriverRecord
 * @property {string} studyId
 * @property {string} ssn
 * @property {'W' | 'D' | 'E'} status - Driver-side view: W written locally, D confirmed by the API, E failed.
 * @property {string} [localPath]
 * @property {string} [error]
 */

/**
 * @typedef {Object} DriverRunReport
 * @property {string} runId
 * @property {DriverRecord[]} records
 */

/**
 * Simulated Windows driver. Talks to the API only over HTTP and follows the
 * production contract: start, poll for ready artifacts, stream each one to local
 * disk, confirm with mark-complete, and record the API's answer.
 */
export class MockDriverGateway {
  #baseUrl;
  #localDir;
  #pollIntervalMs;
  #maxIdleMs;
  #failWrite;

  /**
   * @param {Object} options
   * @param {string} options.baseUrl - API origin, e.g. `http://localhost:3000`.
   * @param {string} [options.localDir] - Stand-in for the driver's local disk.
   * @param {number} [options.pollIntervalMs] - Wait between empty polls.
   * @param {number} [options.maxIdleMs] - Stop after this long without a ready artifact.
   * @param {(studyId: string) => boolean} [options.failWrite] - Simulates a local write failure.
   */
  constructor({
    baseUrl,
    localDir = join(tmpdir(), 'eqa-driver'),
    pollIntervalMs = 100,
    maxIdleMs = 5000,
    failWrite = () => false,
  }) {
    this.#baseUrl = baseUrl;
    this.#localDir = localDir;
    this.#pollIntervalMs = pollIntervalMs;
    this.#maxIdleMs = maxIdleMs;
    this.#failWrite = failWrite;
  }

  /**
   * Runs the whole driver flow for one batch until no artifact has been ready for `maxIdleMs`.
   *
   * @param {Object} request
   * @param {string} request.batchId
   * @param {number} request.sampleLimit
   * @returns {Promise<DriverRunReport>}
   */
  async run({ batchId, sampleLimit }) {
    const { runId } = await this.start({ batchId, sampleLimit });
    /** @type {DriverRecord[]} */
    const records = [];
    let idleSince = Date.now();

    while (records.length < sampleLimit && Date.now() - idleSince < this.#maxIdleMs) {
      const record = await this.transferNext(runId, batchId);
      if (record) {
        records.push(record);
        idleSince = Date.now();
      } else {
        await sleep(this.#pollIntervalMs);
      }
    }
    return { runId, records };
  }

  /**
   * @param {Object} request
   * @param {string} request.batchId
   * @param {number} request.sampleLimit
   * @returns {Promise<{ runId: string, acceptedAt: number }>}
   */
  async start({ batchId, sampleLimit }) {
    const res = await this.#post('/start-processing', { batchId, sampleLimit });
    if (res.status !== 202) {
      throw new Error(`start-processing answered ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * One poll cycle: fetch the next ready artifact, write it locally, confirm it.
   *
   * @param {string} runId
   * @param {string} batchId
   * @returns {Promise<DriverRecord | null>} Null when nothing was ready.
   */
  async transferNext(runId, batchId) {
    const res = await fetch(`${this.#baseUrl}/ready-jars?batchId=${encodeURIComponent(batchId)}`);
    if (res.status === 204) return null;
    if (res.status !== 200 || !res.body) {
      throw new Error(`ready-jars answered ${res.status}: ${await res.text()}`);
    }

    const studyId = /** @type {string} */ (res.headers.get('x-study-id'));
    const ssn = /** @type {string} */ (res.headers.get('x-ssn'));
    const localPath = join(this.#localDir, studyId, `${studyId}.jar`);

    /** @type {{ checksum: string, sizeBytes: number } | null} */
    let written = null;
    let writeError;
    try {
      written = await this.#writeLocally(Readable.fromWeb(res.body), localPath, studyId);
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
    }

    const confirmation = written
      ? { runId, studyId, ssn, status: 'W', ...written }
      : { runId, studyId, ssn, status: 'E' };
    const ack = await this.#post('/mark-complete', confirmation);
    const body = await ack.json();

    if (ack.status === 200 && body.synced) {
      return { studyId, ssn, status: 'D', localPath };
    }
    return {
      studyId,
      ssn,
      status: 'E',
      localPath: written ? localPath : undefined,
      error: writeError ?? body.error ?? 'API did not confirm the write',
    };
  }

  /**
   * Streams the artifact to disk, hashing it on the way, so the driver can report
   * what it actually wrote.
   *
   * @param {Readable} body
   * @param {string} localPath
   * @param {string} studyId
   * @returns {Promise<{ checksum: string, sizeBytes: number }>}
   */
  async #writeLocally(body, localPath, studyId) {
    if (this.#failWrite(studyId)) {
      body.destroy();
      throw new Error(`Simulated local write failure for ${studyId}`);
    }
    await mkdir(join(localPath, '..'), { recursive: true });

    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(body, meter, createWriteStream(localPath));
    return { checksum: `sha256:${hash.digest('hex')}`, sizeBytes };
  }

  /**
   * @param {string} path
   * @param {unknown} payload
   * @returns {Promise<Response>}
   */
  #post(path, payload) {
    return fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
