import { createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { IStorageService } from '../../ports/IStorageService.js';

/**
 * Stand-in for S3 multipart upload. Consumes the stream with real backpressure and discards
 * the bytes into `/dev/null`, so the test measures memory, not disk throughput.
 */
export class S3StreamStorage extends IStorageService {
  /**
   * @param {string} filename - Object key; unused by the mock beyond the contract.
   * @param {import('node:stream').Readable} readableStream
   * @returns {Promise<void>}
   */
  async uploadStream(filename, readableStream) {
    await pipeline(readableStream, new PassThrough(), createWriteStream('/dev/null'));
  }
}
