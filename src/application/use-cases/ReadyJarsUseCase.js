import { InvalidTransitionError, LifecycleStatus } from '../../domain/entities/StudyState.js';

/**
 * @typedef {import('../../ports/IStorageService.js').IStorageService} IStorageService
 * @typedef {import('../../ports/IStateStore.js').IStateStore} IStateStore
 * @typedef {import('../../ports/IStateStore.js').ArtifactMeta} ArtifactMeta
 */

/**
 * @typedef {Object} ReadyJar
 * @property {string} studyId
 * @property {string} ssn
 * @property {ArtifactMeta} artifact
 * @property {import('node:stream').Readable} stream - Artifact bytes, read lazily from storage.
 */

export class InvalidReadyRequestError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'InvalidReadyRequestError';
  }
}

/**
 * Hands the next ready artifact of a batch to the driver. The study moves R -> S
 * as the transfer starts; the bytes are streamed from storage, never buffered.
 */
export class ReadyJarsUseCase {
  #storageService;
  #stateStore;

  /**
   * @param {IStorageService} storageService
   * @param {IStateStore} stateStore
   */
  constructor(storageService, stateStore) {
    this.#storageService = storageService;
    this.#stateStore = stateStore;
  }

  /**
   * @param {string} batchId
   * @returns {Promise<ReadyJar | null>} Null when no study of the batch is in R.
   * @throws {InvalidReadyRequestError}
   */
  async execute(batchId) {
    if (typeof batchId !== 'string' || batchId.trim() === '') {
      throw new InvalidReadyRequestError('batchId must be a non-empty string');
    }

    const ready = await this.#stateStore.findByBatch(batchId, LifecycleStatus.READY);
    for (const candidate of ready) {
      // markSent is the claim: if another poller got there first, try the next one.
      try {
        await this.#stateStore.markSent(candidate.studyId);
      } catch (error) {
        if (error instanceof InvalidTransitionError) continue;
        throw error;
      }
      return this.#open(candidate.studyId, candidate.ssn, candidate.artifact);
    }
    return null;
  }

  /**
   * @param {string} studyId
   * @param {string} ssn
   * @param {ArtifactMeta} artifact
   * @returns {Promise<ReadyJar>}
   */
  async #open(studyId, ssn, artifact) {
    try {
      const stream = await this.#storageService.getArtifact(studyId, ssn);
      return { studyId, ssn, artifact, stream };
    } catch (error) {
      await this.#stateStore.markError(studyId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
