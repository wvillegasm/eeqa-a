## Execution Plan: Simulation and Measurement Strategy

This plan defines how we will stress-test the hexagonal MVP to extract empirical metrics that debunk fears of blocking and memory saturation.

### 1. Tools and Environment

- **Environment:** Deployment of the MVP in a Docker container with strict resource limits (e.g., 1 CPU core, 512MB RAM) to simulate an OpenShift Pod (PaaS).
- **Load Generator:** `Autocannon` (Node.js-based, excellent for HTTP pipelining) or `k6`.
- **Telemetry:** `Clinic.js Doctor` to profile the Event Loop, and a custom Express middleware using `process.memoryUsage()` and `perf_hooks`.

### 2. Test Scenario Design

**Scenario A: Extreme Concurrency Test (I/O-Bound)**

- **Objective:** Demonstrate that the main thread is not blocked by heavy calls to DB2 or T2/T18.
- **Execution:** Send 2,000 concurrent requests to the endpoint for 30 seconds. Each request will internally take ~5 seconds (due to delays injected in the mocks).
- **Success Metric:** The server must not reject connections (`0` `ECONNREFUSED` or `ETIMEOUT` errors). The response time of a parallel simple request (e.g., `GET /health`) must remain under 50ms throughout the barrage.

**Scenario B: Massive File Streaming Test (C3)**

- **Objective:** Demonstrate that transferring giant files (100MB+) to S3 does not consume the container's RAM.
- **Execution:** Modify `MockT2T18Client` to generate a 200MB data flow (`Readable Stream`) in dynamic memory. Launch 50 concurrent requests for this stream.
- **Success Metric:** If loaded into RAM, 50 \* 200MB would consume 10GB of memory, immediately crashing the 512MB container (`OOMKilled`). By using Streams, we should observe in the logs that the Node.js `heapUsed` metric never exceeds 80-100MB total throughout the test.

### 3. Telemetry Capture and Reporting

- **Monitoring Middleware (To be injected into the MVP):**

```javascript
setInterval(() => {
  const memory = process.memoryUsage();
  console.log(`Heap Used: ${Math.round(memory.heapUsed / 1024 / 1024)} MB`);
}, 1000);
```

- **Clinic.js Report:** Wrap the server execution with `clinic doctor -- node src/main.js`. This will generate an interactive HTML graph at the end of the Autocannon test.
- **Final Deliverable for the Team:** A report showing the Event Loop Lag graph (which should remain close to 0) overlaid with the CPU and RAM usage graphs, visually proving that Node.js spent most of its time sleeping (waiting for I/O) while safely processing thousands of transactions.
