/**
 * Study lifecycle states. The MVP uses these four words and nothing else.
 *
 * @readonly
 * @enum {string}
 */
export const StudyStatus = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
});

/**
 * @typedef {'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR'} StudyStatusValue
 */

export class Study {
  /** @type {string} */
  id;
  /** @type {string} */
  ssn;
  /** @type {StudyStatusValue} */
  status;
  /** @type {number} Payload size in bytes. */
  payloadSize;

  /**
   * @param {Object} props
   * @param {string} props.id
   * @param {string} props.ssn
   * @param {number} props.payloadSize - Bytes.
   * @param {StudyStatusValue} [props.status]
   */
  constructor({ id, ssn, payloadSize, status = StudyStatus.PENDING }) {
    this.id = id;
    this.ssn = ssn;
    this.payloadSize = payloadSize;
    this.status = status;
  }

  markAsProcessing() {
    this.status = StudyStatus.PROCESSING;
  }

  markAsCompleted() {
    this.status = StudyStatus.COMPLETED;
  }

  markAsError() {
    this.status = StudyStatus.ERROR;
  }
}
