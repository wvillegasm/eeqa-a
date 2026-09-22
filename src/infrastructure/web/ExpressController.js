import { Router } from 'express';

/**
 * @typedef {import('../../application/use-cases/ProcessStudyUseCase.js').ProcessStudyUseCase} ProcessStudyUseCase
 */

/**
 * Builds the HTTP adapter. The process endpoint holds the request open until the use case
 * settles, so each request occupies the server for the full simulated I/O duration.
 *
 * @param {ProcessStudyUseCase} processStudyUseCase
 * @returns {import('express').Router}
 */
export function createStudyRouter(processStudyUseCase) {
  const router = Router();

  router.post('/api/v1/studies/:id/process', async (req, res) => {
    try {
      const study = await processStudyUseCase.execute(req.params.id);
      res.status(200).json(study);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return router;
}
