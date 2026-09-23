import { NotImplementedError } from './NotImplementedError.js';

/**
 * @typedef {import('../domain/entities/Study.js').Study} Study
 */

/**
 * Port: persistence of studies (DB2 in the real system).
 */
export class IStudyRepository {
  /**
   * @returns {Promise<Study[]>} Every study currently in PENDING.
   */
  async getPendingStudies() {
    throw new NotImplementedError('IStudyRepository.getPendingStudies');
  }

  /**
   * @param {string} id
   * @returns {Promise<Study>} Rejects when the study does not exist.
   */
  async getStudyById(id) {
    throw new NotImplementedError('IStudyRepository.getStudyById');
  }

  /**
   * @param {Study} study
   * @returns {Promise<void>}
   */
  async updateStudyStatus(study) {
    throw new NotImplementedError('IStudyRepository.updateStudyStatus');
  }
}
