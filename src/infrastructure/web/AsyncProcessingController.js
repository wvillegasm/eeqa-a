import { Router, json } from 'express';
import { InvalidStartRequestError } from '../../application/use-cases/StartProcessingUseCase.js';

/**
 * @typedef {import('../../application/use-cases/StartProcessingUseCase.js').StartProcessingUseCase} StartProcessingUseCase
 */

/**
 * HTTP adapter for starting a lifecycle run. Answers 202 immediately; the run
 * continues in the background.
 *
 * @param {StartProcessingUseCase} startProcessingUseCase
 * @returns {import('express').Router}
 */
export function createAsyncProcessingRouter(startProcessingUseCase) {
  const router = Router();

  router.post('/start-processing', json(), (req, res) => {
    try {
      const run = startProcessingUseCase.execute({
        batchId: req.body?.batchId,
        sampleLimit: req.body?.sampleLimit,
      });
      res.status(202).json({ status: 'ACCEPTED', runId: run.runId, acceptedAt: run.acceptedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(error instanceof InvalidStartRequestError ? 400 : 500).json({ error: message });
    }
  });

  return router;
}
