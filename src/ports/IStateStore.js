import { NotImplementedError } from './NotImplementedError.js';

/**
 * @typedef {ReturnType<import('../domain/entities/StudyState.js').StudyState['toJSON']>} StateDocument
 * @typedef {import('../domain/entities/StudyState.js').ArtifactMeta} ArtifactMeta
 */

/**
 * Port: durable working-state store holding one STATE.JSON document per study
 * (an S3 object in the real system). System of record for lifecycle transitions.
 */
export class IStateStore {
  /**
   * Creates the document in K when missing, then applies the patch. A `status`
   * in the patch goes through the domain transition rules.
   *
   * @param {string} studyId
   * @param {Partial<Pick<StateDocument, 'batchId' | 'ssn' | 'status'>>} patch
   * @returns {Promise<StateDocument>}
   */
  async createOrUpdateState(studyId, patch) {
    throw new NotImplementedError('IStateStore.createOrUpdateState');
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument | null>} Null when no document exists.
   */
  async getState(studyId) {
    throw new NotImplementedError('IStateStore.getState');
  }

  /**
   * @param {string} batchId
   * @param {import('../domain/entities/StudyState.js').LifecycleStatusValue} status
   * @returns {Promise<StateDocument[]>} Documents of that batch currently in `status`, oldest update first.
   */
  async findByBatch(batchId, status) {
    throw new NotImplementedError('IStateStore.findByBatch');
  }

  /**
   * @param {string} studyId
   * @param {ArtifactMeta} artifactMeta
   * @returns {Promise<StateDocument>}
   */
  async markReady(studyId, artifactMeta) {
    throw new NotImplementedError('IStateStore.markReady');
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument>}
   */
  async markSent(studyId) {
    throw new NotImplementedError('IStateStore.markSent');
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument>}
   */
  async markWritten(studyId) {
    throw new NotImplementedError('IStateStore.markWritten');
  }

  /**
   * @param {string} studyId
   * @returns {Promise<StateDocument>}
   */
  async markDone(studyId) {
    throw new NotImplementedError('IStateStore.markDone');
  }

  /**
   * @param {string} studyId
   * @param {string} reason
   * @returns {Promise<StateDocument>}
   */
  async markError(studyId, reason) {
    throw new NotImplementedError('IStateStore.markError');
  }
}
