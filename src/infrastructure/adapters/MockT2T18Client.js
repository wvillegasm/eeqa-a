import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { IInfoServiceClient } from '../../ports/IInfoServiceClient.js';

const DEFAULT_CHUNK_SIZE = 64 * 1024;

/**
 * Readable that fabricates `totalBytes` of payload one chunk per `_read`, so memory
 * stays bounded by the stream's highWaterMark regardless of payload size.
 */
class GeneratedPayloadStream extends Readable {
  #remaining;
  #chunkSize;
  #fill;

  /**
   * @param {number} totalBytes
   * @param {number} chunkSize
   * @param {number} fill - Byte value written into every chunk.
   */
  constructor(totalBytes, chunkSize, fill) {
    super({ highWaterMark: chunkSize });
    this.#remaining = totalBytes;
    this.#chunkSize = chunkSize;
    this.#fill = fill;
  }

  _read() {
    if (this.#remaining <= 0) {
      this.push(null);
      return;
    }
    const size = Math.min(this.#chunkSize, this.#remaining);
    this.#remaining -= size;
    this.push(Buffer.alloc(size, this.#fill));
  }
}

/**
 * Stand-in for the T2T18 information service: slow to answer, then streams a large payload.
 */
export class MockT2T18Client extends IInfoServiceClient {
  #latencyMinMs;
  #latencyMaxMs;
  #payloadSize;
  #failureRate;
  #chunkSize;

  /**
   * @param {Object} options
   * @param {number} options.latencyMinMs
   * @param {number} options.latencyMaxMs
   * @param {number} options.payloadSize - Bytes emitted per fetch.
   * @param {number} options.failureRate - Probability in [0, 1] that a fetch throws.
   * @param {number} [options.chunkSize]
   */
  constructor({ latencyMinMs, latencyMaxMs, payloadSize, failureRate, chunkSize = DEFAULT_CHUNK_SIZE }) {
    super();
    this.#latencyMinMs = latencyMinMs;
    this.#latencyMaxMs = latencyMaxMs;
    this.#payloadSize = payloadSize;
    this.#failureRate = failureRate;
    this.#chunkSize = chunkSize;
  }

  /**
   * @param {string} ssn
   * @returns {Promise<Readable>}
   */
  async fetchT2T18Data(ssn) {
    const delay = this.#latencyMinMs + Math.random() * (this.#latencyMaxMs - this.#latencyMinMs);
    await sleep(delay);
    if (Math.random() < this.#failureRate) {
      throw new Error(`T2T18 fetch failed for ssn ${ssn}`);
    }
    return new GeneratedPayloadStream(this.#payloadSize, this.#chunkSize, 0x61);
  }
}
