import { InvalidTransitionError, LifecycleStatus } from '../../domain/entities/StudyState.js';

/**
 * @typedef {import('../../ports/IStateStore.js').IStateStore} IStateStore
 * @typedef {import('../../ports/IStateStore.js').StateDocument} StateDocument
 */

/**
 * @typedef {Object} CompletionRequest
 * @property {string} runId
 * @property {string} studyId
 * @property {string} ssn
 * @property {string} status - Driver-reported status; only 'W' confirms a successful write.
 * @property {string} [checksum] - `sha256:<hex>` of the file the driver wrote.
 * @property {number} [sizeBytes] - Size of the file the driver wrote.
 */

/**
 * @typedef {Object} CompletionResult
 * @property {'ACK'} status
 * @property {boolean} synced - True only when the study ended in D.
 * @property {StateDocument} state
 */

export class InvalidCompleteRequestError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'InvalidCompleteRequestError';
  }
}

export class StudyStateNotFoundError extends Error {
  /**
   * @param {string} studyId
   */
  constructor(studyId) {
    super(`State not found: ${studyId}`);
    this.name = 'StudyStateNotFoundError';
  }
}

export class CompletionConflictError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'CompletionConflictError';
  }
}

const { SENT, WRITTEN, DONE, ERROR } = LifecycleStatus;

/** Bound on retries when a concurrent confirmation moves the state under us. */
const MAX_ATTEMPTS = 3;

/**
 * Records the driver's write confirmation. S -> W on a 'W' report, then W -> D
 * only when the reported checksum and size match the stored artifact; anything
 * else ends in E. Repeated calls on a finished study return its outcome unchanged.
 */
export class MarkCompleteUseCase {
  #stateStore;

  /**
   * @param {IStateStore} stateStore
   */
  constructor(stateStore) {
    this.#stateStore = stateStore;
  }

  /**
   * @param {CompletionRequest} request
   * @returns {Promise<CompletionResult>}
   * @throws {InvalidCompleteRequestError | StudyStateNotFoundError | CompletionConflictError}
   */
  async execute(request) {
    MarkCompleteUseCase.#validate(request);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.#advance(request);
      } catch (error) {
        // Another confirmation moved the state first; re-read and decide again.
        if (error instanceof InvalidTransitionError) continue;
        throw error;
      }
    }
    throw new CompletionConflictError(`Concurrent confirmations for ${request.studyId}`);
  }

  /**
   * @param {CompletionRequest} request
   * @returns {Promise<CompletionResult>}
   */
  async #advance({ runId, studyId, ssn, status, checksum, sizeBytes }) {
    let state = await this.#stateStore.getState(studyId);
    if (!state) {
      throw new StudyStateNotFoundError(studyId);
    }
    if (state.runId !== runId || state.ssn !== ssn) {
      throw new CompletionConflictError(`runId/ssn do not match state of ${studyId}`);
    }

    switch (state.status) {
      case DONE:
      case ERROR:
        return MarkCompleteUseCase.#result(state);
      case SENT:
        if (status !== WRITTEN) {
          state = await this.#stateStore.markError(studyId, `Driver reported status ${status}`);
          return MarkCompleteUseCase.#result(state);
        }
        state = await this.#stateStore.markWritten(studyId);
      // falls through: W is validated below
      case WRITTEN:
        state = await this.#verifyWrite(state, checksum, sizeBytes);
        return MarkCompleteUseCase.#result(state);
      default:
        throw new CompletionConflictError(`Study ${studyId} is in ${state.status}, not in transfer`);
    }
  }

  /**
   * Post-write validation: the driver's file must match the stored artifact.
   *
   * @param {StateDocument} state
   * @param {string | undefined} checksum
   * @param {number | undefined} sizeBytes
   * @returns {Promise<StateDocument>} State in D, or in E when validation fails.
   */
  async #verifyWrite(state, checksum, sizeBytes) {
    const { studyId, artifact } = state;
    if (checksum === undefined || sizeBytes === undefined) {
      return this.#stateStore.markError(studyId, 'Missing write confirmation: checksum and sizeBytes required');
    }
    if (!artifact || artifact.checksum !== checksum || artifact.sizeBytes !== sizeBytes) {
      return this.#stateStore.markError(studyId, 'Written artifact does not match stored checksum/size');
    }
    return this.#stateStore.markDone(studyId);
  }

  /**
   * @param {StateDocument} state
   * @returns {CompletionResult}
   */
  static #result(state) {
    return { status: 'ACK', synced: state.status === DONE, state };
  }

  /**
   * Rejects malformed payloads before any state is touched.
   *
   * @param {CompletionRequest} request
   */
  static #validate(request) {
    for (const field of ['runId', 'studyId', 'ssn', 'status']) {
      const value = request?.[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidCompleteRequestError(`${field} must be a non-empty string`);
      }
    }
    if (request.checksum !== undefined && typeof request.checksum !== 'string') {
      throw new InvalidCompleteRequestError('checksum must be a string');
    }
    if (request.sizeBytes !== undefined && (!Number.isInteger(request.sizeBytes) || request.sizeBytes < 0)) {
      throw new InvalidCompleteRequestError('sizeBytes must be a non-negative integer');
    }
  }
}
