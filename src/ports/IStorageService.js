import { NotImplementedError } from './NotImplementedError.js';

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
}
