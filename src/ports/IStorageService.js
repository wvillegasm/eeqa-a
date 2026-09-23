import { NotImplementedError } from './NotImplementedError.js';

/**
 * @typedef {import('../domain/entities/StudyState.js').ArtifactMeta} ArtifactMeta
 */

/**
 * Port: object storage for study payloads (AWS S3 in the real system).
 */
export class IStorageService {
  /**
   * @param {string} filename
   * @param {import('node:stream').Readable} readableStream
   * @returns {Promise<void>} Resolves once the whole stream has been stored.
   */
  async uploadStream(filename, readableStream) {
    throw new NotImplementedError('IStorageService.uploadStream');
  }

  /**
   * Stores a generated study artifact without buffering it in memory.
   *
   * @param {string} studyId
   * @param {string} ssn
   * @param {import('node:stream').Readable} stream
   * @returns {Promise<ArtifactMeta>} Resolves once the whole stream has been stored.
   */
  async saveArtifact(studyId, ssn, stream) {
    throw new NotImplementedError('IStorageService.saveArtifact');
  }

  /**
   * @param {string} studyId
   * @param {string} ssn
   * @returns {Promise<import('node:stream').Readable>} Rejects when the artifact does not exist.
   */
  async getArtifact(studyId, ssn) {
    throw new NotImplementedError('IStorageService.getArtifact');
  }
}
