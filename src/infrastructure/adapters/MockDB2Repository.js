import { setTimeout as sleep } from 'node:timers/promises';
import { IStudyRepository } from '../../ports/IStudyRepository.js';
import { Study } from '../../domain/entities/Study.js';

/**
 * Counting semaphore modelling the DB2 connection pool. Waiters are served FIFO.
 */
class Semaphore {
  /** @type {number} */
  #permits;
  /** @type {Array<() => void>} */
  #waiters = [];

  /**
   * @param {number} permits
   */
  constructor(permits) {
    this.#permits = permits;
  }

  /**
   * @returns {Promise<void>}
   */
  acquire() {
    if (this.#permits > 0) {
      this.#permits--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release() {
    const next = this.#waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter; the count stays unchanged.
      next();
    } else {
      this.#permits++;
    }
  }
}

/**
 * In-memory stand-in for DB2. Every call waits for a pool slot, then for the injected latency.
 */
export class MockDB2Repository extends IStudyRepository {
  /** @type {Map<string, Study>} */
  #studies = new Map();
  /** @type {Semaphore} */
  #pool;
  /** @type {number} */
  #latencyMs;
  #inFlight = 0;
  #peakInFlight = 0;

  /**
   * @param {Object} options
   * @param {number} options.latencyMs - Simulated query latency.
   * @param {number} options.maxConcurrency - Connection pool size.
   * @param {number} options.seedSize - Number of studies seeded as `study-1` … `study-N`.
   * @param {number} options.payloadSize - Bytes assigned to every seeded study.
   */
  constructor({ latencyMs, maxConcurrency, seedSize, payloadSize }) {
    super();
    this.#latencyMs = latencyMs;
    this.#pool = new Semaphore(maxConcurrency);
    for (let i = 1; i <= seedSize; i++) {
      const study = new Study({
        id: `study-${i}`,
        ssn: String(i).padStart(9, '0'),
        payloadSize,
      });
      this.#studies.set(study.id, study);
    }
  }

  /** Calls currently holding a pool slot. */
  get inFlight() {
    return this.#inFlight;
  }

  /** Highest `inFlight` value observed since construction. */
  get peakInFlight() {
    return this.#peakInFlight;
  }

  /**
   * @param {string} id
   * @returns {Promise<Study>}
   */
  async getStudyById(id) {
    return this.#withConnection(() => {
      const stored = this.#studies.get(id);
      if (!stored) {
        throw new Error(`Study not found: ${id}`);
      }
      return new Study({ ...stored });
    });
  }

  /**
   * @param {Study} study
   * @returns {Promise<void>}
   */
  async updateStudyStatus(study) {
    return this.#withConnection(() => {
      const stored = this.#studies.get(study.id);
      if (!stored) {
        throw new Error(`Study not found: ${study.id}`);
      }
      this.#studies.set(study.id, new Study({ ...stored, status: study.status }));
    });
  }

  /**
   * @template T
   * @param {() => T} work
   * @returns {Promise<T>}
   */
  async #withConnection(work) {
    await this.#pool.acquire();
    this.#inFlight++;
    this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight);
    try {
      await sleep(this.#latencyMs);
      return work();
    } finally {
      this.#inFlight--;
      this.#pool.release();
    }
  }
}
