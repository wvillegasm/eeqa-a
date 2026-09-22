/**
 * Runtime configuration. Read once here; nothing deeper in the tree touches `process.env`.
 *
 * @typedef {Object} Config
 * @property {number} port
 * @property {number} db2LatencyMs
 * @property {number} db2MaxConcurrency
 * @property {number} t2t18LatencyMinMs
 * @property {number} t2t18LatencyMaxMs
 * @property {number} payloadSizeMb
 * @property {number} failureRate - Probability in [0, 1] that a T2T18 fetch fails.
 * @property {number} seedSize
 * @property {number} heapLogIntervalMs
 */

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value for ${name}: "${raw}"`);
  }
  return value;
}

/** @type {Readonly<Config>} */
const config = Object.freeze({
  port: numberFromEnv('PORT', 3000),
  db2LatencyMs: numberFromEnv('DB2_LATENCY_MS', 1500),
  db2MaxConcurrency: numberFromEnv('DB2_MAX_CONCURRENCY', 30),
  t2t18LatencyMinMs: numberFromEnv('T2T18_LATENCY_MIN_MS', 3000),
  t2t18LatencyMaxMs: numberFromEnv('T2T18_LATENCY_MAX_MS', 5000),
  payloadSizeMb: numberFromEnv('PAYLOAD_SIZE_MB', 100),
  failureRate: numberFromEnv('FAILURE_RATE', 0),
  seedSize: numberFromEnv('SEED_SIZE', 1000),
  heapLogIntervalMs: numberFromEnv('HEAP_LOG_INTERVAL_MS', 1000),
});

export default config;
