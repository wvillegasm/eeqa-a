/**
 * Context of one accepted `start-processing` request. Pure value object; the
 * per-study lifecycle lives in StudyState, not here.
 */
export class RunState {
  /** @type {string} */
  runId;
  /** @type {string} */
  batchId;
  /** @type {number} Maximum number of pending studies this run may claim. */
  sampleLimit;
  /** @type {number} Epoch ms. */
  acceptedAt;

  /**
   * @param {Object} props
   * @param {string} props.runId
   * @param {string} props.batchId
   * @param {number} props.sampleLimit
   * @param {number} props.acceptedAt
   */
  constructor({ runId, batchId, sampleLimit, acceptedAt }) {
    this.runId = runId;
    this.batchId = batchId;
    this.sampleLimit = sampleLimit;
    this.acceptedAt = acceptedAt;
  }
}
