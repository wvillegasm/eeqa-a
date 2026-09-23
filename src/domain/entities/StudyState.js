/**
 * Async lifecycle states for an eQA study, as defined in the architecture
 * specification. Persisted in STATE.JSON; single-letter codes are the contract.
 *
 * @readonly
 * @enum {string}
 */
export const LifecycleStatus = Object.freeze({
  PENDING: 'K',
  PROCESSING: 'P',
  READY: 'R',
  SENT: 'S',
  WRITTEN: 'W',
  DONE: 'D',
  ERROR: 'E',
});

/**
 * @typedef {'K' | 'P' | 'R' | 'S' | 'W' | 'D' | 'E'} LifecycleStatusValue
 */

/**
 * @typedef {Object} ArtifactMeta
 * @property {string} name
 * @property {string} path
 * @property {number} sizeBytes
 * @property {string} checksum
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {LifecycleStatusValue} status
 * @property {number} at - Epoch milliseconds.
 * @property {string} [reason] - Present only on the E entry.
 */

const { PENDING, PROCESSING, READY, SENT, WRITTEN, DONE, ERROR } = LifecycleStatus;

/** Allowed forward transitions. Any non-terminal state may also move to E. */
const TRANSITIONS = Object.freeze({
  [PENDING]: [PROCESSING],
  [PROCESSING]: [READY],
  [READY]: [SENT],
  [SENT]: [WRITTEN],
  [WRITTEN]: [DONE],
  [DONE]: [],
  [ERROR]: [],
});

export class InvalidTransitionError extends Error {
  /**
   * @param {LifecycleStatusValue} from
   * @param {LifecycleStatusValue} to
   */
  constructor(from, to) {
    super(`Invalid lifecycle transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Pure lifecycle model backing one STATE.JSON document. Knows nothing about
 * HTTP, streams or storage; callers supply timestamps.
 */
export class StudyState {
  /** @type {string} */
  studyId;
  /** @type {string} */
  batchId;
  /** @type {string | null} Run that claimed the study. */
  runId;
  /** @type {string} */
  ssn;
  /** @type {LifecycleStatusValue} */
  status;
  /** @type {ArtifactMeta | null} */
  artifact;
  /** @type {HistoryEntry[]} */
  history;
  /** @type {number} */
  updatedAt;

  /**
   * @param {Object} props
   * @param {string} props.studyId
   * @param {string} props.batchId
   * @param {string} props.ssn
   * @param {number} props.at - Creation time, epoch ms.
   * @param {string | null} [props.runId]
   */
  constructor({ studyId, batchId, ssn, at, runId = null }) {
    this.studyId = studyId;
    this.batchId = batchId;
    this.runId = runId;
    this.ssn = ssn;
    this.status = PENDING;
    this.artifact = null;
    this.history = [{ status: PENDING, at }];
    this.updatedAt = at;
  }

  /**
   * @param {LifecycleStatusValue} status
   * @returns {boolean}
   */
  static isTerminal(status) {
    return status === DONE || status === ERROR;
  }

  /**
   * @param {LifecycleStatusValue} to
   * @returns {boolean}
   */
  canTransitionTo(to) {
    if (to === ERROR) return !StudyState.isTerminal(this.status);
    return TRANSITIONS[this.status].includes(to);
  }

  /**
   * @param {LifecycleStatusValue} to
   * @param {number} at - Epoch ms.
   * @param {string} [reason] - Only recorded for E.
   * @throws {InvalidTransitionError}
   */
  transitionTo(to, at, reason) {
    if (!this.canTransitionTo(to)) {
      throw new InvalidTransitionError(this.status, to);
    }
    this.status = to;
    this.updatedAt = at;
    this.history.push(to === ERROR && reason ? { status: to, at, reason } : { status: to, at });
  }

  /**
   * @param {number} at
   */
  markProcessing(at) {
    this.transitionTo(PROCESSING, at);
  }

  /**
   * @param {ArtifactMeta} artifact
   * @param {number} at
   */
  markReady(artifact, at) {
    this.transitionTo(READY, at);
    this.artifact = { ...artifact };
  }

  /**
   * @param {number} at
   */
  markSent(at) {
    this.transitionTo(SENT, at);
  }

  /**
   * @param {number} at
   */
  markWritten(at) {
    this.transitionTo(WRITTEN, at);
  }

  /**
   * @param {number} at
   */
  markDone(at) {
    this.transitionTo(DONE, at);
  }

  /**
   * @param {string} reason
   * @param {number} at
   */
  markError(reason, at) {
    this.transitionTo(ERROR, at, reason);
  }

  /**
   * Serialises to the STATE.JSON document shape.
   */
  toJSON() {
    return {
      studyId: this.studyId,
      batchId: this.batchId,
      runId: this.runId,
      ssn: this.ssn,
      status: this.status,
      artifact: this.artifact ? { ...this.artifact } : null,
      history: this.history.map((entry) => ({ ...entry })),
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Rehydrates from a STATE.JSON document.
   *
   * @param {ReturnType<StudyState['toJSON']>} json
   * @returns {StudyState}
   */
  static fromJSON(json) {
    const state = new StudyState({
      studyId: json.studyId,
      batchId: json.batchId,
      runId: json.runId ?? null,
      ssn: json.ssn,
      at: json.history[0]?.at ?? json.updatedAt,
    });
    state.status = json.status;
    state.artifact = json.artifact ? { ...json.artifact } : null;
    state.history = json.history.map((entry) => ({ ...entry }));
    state.updatedAt = json.updatedAt;
    return state;
  }
}
