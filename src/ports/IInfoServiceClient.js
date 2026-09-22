import { NotImplementedError } from './NotImplementedError.js';

/**
 * Port: information service that yields study payloads (T2T18 in the real system).
 */
export class IInfoServiceClient {
  /**
   * @param {string} ssn
   * @returns {Promise<import('node:stream').Readable>} Stream of the study payload.
   */
  async fetchT2T18Data(ssn) {
    throw new NotImplementedError('IInfoServiceClient.fetchT2T18Data');
  }
}
