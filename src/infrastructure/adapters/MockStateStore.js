import { IStateStore } from '../../ports/IStateStore.js';
import { StudyState } from '../../domain/entities/StudyState.js';

/**
 * @typedef {import('../../ports/IStateStore.js').StateDocument} StateDocument
 * @typedef {import('../../ports/IStateStore.js').ArtifactMeta} ArtifactMeta
 */

/**
 * In-memory stand-in for the S3 working store. Each study's state is kept as a
 * serialised STATE.JSON string, so nothing downstream can hold a live reference
 * and every read goes through the persisted document.
 */
export class MockStateStore extends IStateStore {
  /** @type {Map<string, string>} studyId -> STATE.JSON */
  #documents = new Map();
  /** @type {() => number} */
  #now;

  /**
   * @param {Object} [options]
   * @param {() => number} [options.now] - Clock, epoch ms. Injectable for tests.
   */
  constructor({ now = Date.now } = {}) {
    super();
    this.#now = now;
  }

  /**
   * @param {string} studyId
   * @param {Partial<Pick<StateDocument, 'batchId' | 'runId' | 'ssn' | 'status'>>} patch
   * @returns {Promise<StateDocument>}
   */
  async createOrUpdateState(studyId, patch) {
    const state =
      this.#load(studyId) ??
      new StudyState({ studyId, batchId: patch.batchId, ssn: patch.ssn, at: this.#now() });
    if (patch.batchId !== undefined) state.batchId = patch.batchId;
    if (patch.runId !== undefined) state.runId = patch.runId;
    if (patch.ssn !== undefined) state.ssn = patch.ssn;
    if (patch.status !== undefined && patch.status !== state.status) {
      state.transitionTo(patch.status, this.#now());
    }
    return this.#save(state);
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument | null>}
   */
  async getState(studyId) {
    const raw = this.#documents.get(studyId);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * @param {string} batchId
   * @param {import('../../domain/entities/StudyState.js').LifecycleStatusValue} status
   * @returns {Promise<StateDocument[]>}
   */
  async findByBatch(batchId, status) {
    return [...this.#documents.values()]
      .map((raw) => JSON.parse(raw))
      .filter((doc) => doc.batchId === batchId && doc.status === status)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  /**
   * @param {string} studyId
   * @param {ArtifactMeta} artifactMeta
   * @returns {Promise<StateDocument>}
   */
  async markReady(studyId, artifactMeta) {
    return this.#mutate(studyId, (state, at) => state.markReady(artifactMeta, at));
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument>}
   */
  async markSent(studyId) {
    return this.#mutate(studyId, (state, at) => state.markSent(at));
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument>}
   */
  async markWritten(studyId) {
    return this.#mutate(studyId, (state, at) => state.markWritten(at));
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument>}
   */
  async markDone(studyId) {
    return this.#mutate(studyId, (state, at) => state.markDone(at));
  }

  /**
   * @param {string} studyId
   * @param {string} reason
   * @returns {Promise<StateDocument>}
   */
  async markError(studyId, reason) {
    return this.#mutate(studyId, (state, at) => state.markError(reason, at));
  }

  /**
   * @param {string} studyId
   * @param {(state: StudyState, at: number) => void} apply
   * @returns {StateDocument}
   */
  #mutate(studyId, apply) {
    const state = this.#load(studyId);
    if (!state) {
      throw new Error(`State not found: ${studyId}`);
    }
    apply(state, this.#now());
    return this.#save(state);
  }

  /**
   * @param {string} studyId
   * @returns {StudyState | null}
   */
  #load(studyId) {
    const raw = this.#documents.get(studyId);
    return raw ? StudyState.fromJSON(JSON.parse(raw)) : null;
  }

  /**
   * @param {StudyState} state
   * @returns {StateDocument}
   */
  #save(state) {
    const raw = JSON.stringify(state);
    this.#documents.set(state.studyId, raw);
    return JSON.parse(raw);
  }
}
