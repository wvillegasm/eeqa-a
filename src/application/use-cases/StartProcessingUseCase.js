import { randomUUID } from 'node:crypto';
import { RunState } from '../../domain/entities/RunState.js';
import { LifecycleStatus } from '../../domain/entities/StudyState.js';

/**
 * @typedef {import('../../ports/IStudyRepository.js').IStudyRepository} IStudyRepository
 * @typedef {import('../../ports/IStateStore.js').IStateStore} IStateStore
 * @typedef {import('./ProcessStudyLifecycleUseCase.js').ProcessStudyLifecycleUseCase} ProcessStudyLifecycleUseCase
 * @typedef {import('../../domain/entities/Study.js').Study} Study
 */

export class InvalidStartRequestError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'InvalidStartRequestError';
  }
}

/**
 * Accepts a processing run and returns at once. Everything slow happens in the
 * background: reading pending studies, claiming them in P, and driving each one
 * to R through ProcessStudyLifecycleUseCase.
 */
export class StartProcessingUseCase {
  #studyRepository;
  #stateStore;
  #processStudyLifecycle;
  #now;
  #generateRunId;
  /** Serialises claim phases so concurrent runs never claim the same study. */
  #claimQueue = Promise.resolve();

  /**
   * @param {IStudyRepository} studyRepository
   * @param {IStateStore} stateStore
   * @param {ProcessStudyLifecycleUseCase} processStudyLifecycle
   * @param {Object} [options]
   * @param {() => number} [options.now] - Clock, epoch ms.
   * @param {() => string} [options.generateRunId]
   */
  constructor(
    studyRepository,
    stateStore,
    processStudyLifecycle,
    { now = Date.now, generateRunId = () => `run-${randomUUID()}` } = {},
  ) {
    this.#studyRepository = studyRepository;
    this.#stateStore = stateStore;
    this.#processStudyLifecycle = processStudyLifecycle;
    this.#now = now;
    this.#generateRunId = generateRunId;
  }

  /**
   * @param {Object} request
   * @param {string} request.batchId
   * @param {number} request.sampleLimit
   * @returns {RunState} The accepted run; processing continues in the background.
   * @throws {InvalidStartRequestError}
   */
  execute({ batchId, sampleLimit }) {
    if (typeof batchId !== 'string' || batchId.trim() === '') {
      throw new InvalidStartRequestError('batchId must be a non-empty string');
    }
    if (!Number.isInteger(sampleLimit) || sampleLimit < 1) {
      throw new InvalidStartRequestError('sampleLimit must be a positive integer');
    }

    const run = new RunState({
      runId: this.#generateRunId(),
      batchId,
      sampleLimit,
      acceptedAt: this.#now(),
    });

    this.#runInBackground(run).catch((error) => {
      console.error(`Run ${run.runId} failed:`, error);
    });
    return run;
  }

  /**
   * @param {RunState} run
   * @returns {Promise<void>}
   */
  async #runInBackground(run) {
    const claimed = await this.#enqueueClaim(run);
    await Promise.allSettled(
      claimed.map((study) => this.#processStudyLifecycle.execute(study.id, study.ssn)),
    );
  }

  /**
   * @param {RunState} run
   * @returns {Promise<Study[]>}
   */
  #enqueueClaim(run) {
    const claim = this.#claimQueue.then(() => this.#claimPending(run));
    // Keep the queue alive even when one claim fails.
    this.#claimQueue = claim.catch(() => {});
    return claim;
  }

  /**
   * Persists P for up to `sampleLimit` pending studies that have no state yet.
   *
   * @param {RunState} run
   * @returns {Promise<Study[]>}
   */
  async #claimPending(run) {
    const pending = await this.#studyRepository.getPendingStudies();
    /** @type {Study[]} */
    const claimed = [];
    for (const study of pending) {
      if (claimed.length >= run.sampleLimit) break;
      if (await this.#stateStore.getState(study.id)) continue;
      await this.#stateStore.createOrUpdateState(study.id, {
        batchId: run.batchId,
        runId: run.runId,
        ssn: study.ssn,
        status: LifecycleStatus.PROCESSING,
      });
      claimed.push(study);
    }
    return claimed;
  }
}
