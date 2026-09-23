import { Router, json } from 'express';
import { pipeline } from 'node:stream/promises';
import { InvalidReadyRequestError } from '../../application/use-cases/ReadyJarsUseCase.js';
import {
  CompletionConflictError,
  InvalidCompleteRequestError,
  StudyStateNotFoundError,
} from '../../application/use-cases/MarkCompleteUseCase.js';

/**
 * @typedef {import('../../application/use-cases/ReadyJarsUseCase.js').ReadyJarsUseCase} ReadyJarsUseCase
 * @typedef {import('../../application/use-cases/MarkCompleteUseCase.js').MarkCompleteUseCase} MarkCompleteUseCase
 */

/**
 * @param {unknown} error
 * @returns {number}
 */
function statusFor(error) {
  if (error instanceof InvalidReadyRequestError || error instanceof InvalidCompleteRequestError) return 400;
  if (error instanceof StudyStateNotFoundError) return 404;
  if (error instanceof CompletionConflictError) return 409;
  return 500;
}

/**
 * HTTP adapter for the driver's polling contract: fetch the next ready artifact,
 * then confirm the local write.
 *
 * @param {ReadyJarsUseCase} readyJarsUseCase
 * @param {MarkCompleteUseCase} markCompleteUseCase
 * @returns {import('express').Router}
 */
export function createDriverRouter(readyJarsUseCase, markCompleteUseCase) {
  const router = Router();

  router.get('/ready-jars', async (req, res) => {
    /** @type {Awaited<ReturnType<ReadyJarsUseCase['execute']>>} */
    let jar;
    try {
      jar = await readyJarsUseCase.execute(req.query.batchId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(statusFor(error)).json({ error: message });
      return;
    }
    if (!jar) {
      res.status(204).end();
      return;
    }

    res.status(200).set({
      'Content-Type': 'application/java-archive',
      'Content-Length': String(jar.artifact.sizeBytes),
      'Content-Disposition': `attachment; filename="${jar.artifact.name}"`,
      'X-Study-Id': jar.studyId,
      'X-Ssn': jar.ssn,
      'X-Checksum': jar.artifact.checksum,
    });
    try {
      await pipeline(jar.stream, res);
    } catch (error) {
      // Headers are already out; the driver sees a truncated body and never confirms.
      console.error(`Transfer of ${jar.studyId} aborted:`, error);
    }
  });

  router.post('/mark-complete', json(), async (req, res) => {
    try {
      const result = await markCompleteUseCase.execute(req.body ?? {});
      res.status(200).json({ status: result.status, synced: result.synced });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(statusFor(error)).json({ error: message });
    }
  });

  return router;
}
