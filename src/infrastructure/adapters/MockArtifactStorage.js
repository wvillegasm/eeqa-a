import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { IStorageService } from '../../ports/IStorageService.js';

/**
 * @typedef {import('../../ports/IStorageService.js').ArtifactMeta} ArtifactMeta
 */

/**
 * Stand-in for the S3 working store's artifact objects. Keeps artifacts on local disk
 * under the production key layout, so they can be streamed back without being
 * buffered in memory. Size and SHA-256 are computed while the bytes flow through.
 */
export class MockArtifactStorage extends IStorageService {
  /** @type {string} */
  #rootDir;

  /**
   * @param {Object} [options]
   * @param {string} [options.rootDir] - Local directory standing in for the bucket.
   */
  constructor({ rootDir = join(tmpdir(), 'eqa-artifacts') } = {}) {
    super();
    this.#rootDir = rootDir;
  }

  /**
   * @param {string} studyId
   * @param {string} ssn
   * @param {import('node:stream').Readable} stream
   * @returns {Promise<ArtifactMeta>}
   */
  async saveArtifact(studyId, ssn, stream) {
    const key = MockArtifactStorage.#key(studyId, ssn);
    const file = join(this.#rootDir, key.path);
    await mkdir(join(this.#rootDir, key.dir), { recursive: true });

    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(stream, meter, createWriteStream(file));

    return {
      name: key.name,
      path: key.path,
      sizeBytes,
      checksum: `sha256:${hash.digest('hex')}`,
    };
  }

  /**
   * @param {string} studyId
   * @param {string} ssn
   * @returns {Promise<import('node:stream').Readable>}
   */
  async getArtifact(studyId, ssn) {
    const file = join(this.#rootDir, MockArtifactStorage.#key(studyId, ssn).path);
    try {
      await access(file);
    } catch {
      throw new Error(`Artifact not found: ${studyId}/${ssn}`);
    }
    return createReadStream(file);
  }

  /**
   * @param {string} studyId
   * @param {string} ssn
   */
  static #key(studyId, ssn) {
    const name = `${studyId}.jar`;
    const dir = `/studies/${studyId}/ssn/${ssn}/artifacts`;
    return { name, dir, path: `${dir}/${name}` };
  }
}
