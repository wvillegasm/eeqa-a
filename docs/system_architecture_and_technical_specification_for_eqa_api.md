# Architecture & Technical Specification Document: eQA-API System

## 1. Executive Summary & Scope

The **eQA System** is an enterprise batch-processing and workflow orchestration platform responsible for gathering, processing, generating support material packages, and updating case states associated with Social Security Numbers (**SSNs**) under the quality assurance review framework (**eQA / MQA**).

This document formalizes the architectural whiteboard specifications into an enterprise-grade technical standard. It establishes component boundaries, asynchronous synchronization flows, intermediate storage mechanisms, the decentralized state machine (`STATE.JSON`), and API messaging contracts.

---

## 2. System Architecture (C4 Container Diagram)

The system is distributed across an on-premises/virtualized Windows environment, a containerized Platform-as-a-Service (PaaS) cluster, AWS cloud services, and legacy enterprise Mainframe subsystems.

```mermaid
flowchart TB
    subgraph Execution_Layer["Batch Execution & Scheduling Layer"]
        Cron["Cron / Task Scheduler"]
        Driver["Driver Daemon / Worker<br/>(Node.js on Windows Server)<br/>• 2 Concurrent Workers<br/>• Pull-based Loop & Status Polling<br/>• Target: ~40 Support Materials/Run"]
    end

    subgraph PaaS_Layer["API & Orchestration Layer (PaaS / OpenShift)"]
        LB["Ingress / Load Balancer"]
        Pod11["Pod 11: eqa-api<br/>(Node.js / Express)"]
        Pod12["Pod 12: eqa-api<br/>(Node.js / Express)"]
        Pod13["Pod 13: eqa-api<br/>(Node.js / Express)"]
        Pool["DB Connection Pool<br/>(Strict 26–30 connections)"]
    end

    subgraph Intermediate_Storage["Cloud Working Storage (WIP)"]
        S3["AWS S3 Bucket (STATE.JSON & WIP)<br/>Key: /studies/{id}/samples/{id}/status/{st}/ssn/{ssn}/"]
    end

    subgraph Network_Storage["Enterprise File Distribution"]
        Disk["Driver Local File System<br/>(\\samples\\ssn...jar)"]
    end

    subgraph Enterprise_Data["Enterprise & Legacy Data Tier"]
        DB2[("IBM DB2 (MQA)<br/>• Studies, Samples & Cases<br/>• Initial State Tracking ('K')")]
        T2T18["T2/T16 Info Service (AWS)<br/>• SSN Case Data<br/>• Historical Archived Data"]
        WebSphere["eQA Enterprise Subsystem<br/>(IBM WebSphere JEE)"]
        USS["USS (Unix System Services)<br/>(z/OS Mainframe Storage)"]
    end

    %% Execution Flows
    Cron -->|"1. Scheduled Trigger"| Driver
    Driver -->|"2. POST /start-processing"| LB
    LB --> Pod11
    LB --> Pod12
    LB --> Pod13

    Pod11 --> Pool
    Pod12 --> Pool
    Pod13 --> Pool

    Pool -->|"3. Query Pending Cases (State: 'K')"| DB2
    Pod12 -->|"4. Fetch Data (T2/T16)"| T2T18
    Pod12 -->|"5. Store JAR & STATE.JSON (State: 'R')"| S3
    Pool -->|"6. Update DB2 State"| DB2

    Driver -->|"7. GET /ready-jars (Poll 'R' State)"| LB
    S3 -.->|"8. Stream Pipe JAR"| LB
    LB -.->|"9. Stream Pipe JAR"| Driver
    Driver -->|"10. Write Local Disk"| Disk
    Driver -->|"11. POST /mark-complete (State: 'W')"| LB
    LB -->|"12. Update STATE.JSON (State: 'W'/'D')"| S3

    %% Legacy Integrations
    WebSphere -.->|"Read/Write Shared Tables"| DB2
    WebSphere -.->|"Mainframe File I/O"| USS

```

---

## 3. Component Boundaries and Responsibilities

### 3.1. `Windows Driver` (Node.js on Windows Server)

- **Runtime Environment:** Windows Server host executing a Node.js process runtime.
- **Activation:** Triggered periodically via a `Cron` daemon or scheduled enterprise batch scheduler passing a unique `batchID`.
- **Concurrency Model:** Configured to run **2 worker threads/loops** concurrently, orchestrating batches containing approximately **40 support material packages** per execution.
- **Core Responsibilities:**

1. Issues the initial asynchronous `START PROCESSING` signal to `eqa-api`.
2. Executes an active polling loop (`SEND ME READY JAR FILES`) querying for ready artifacts.
3. Receives streamed JAR packages and stores them directly onto its local target file system (`DISK`).
4. Performs local verification and emits the final `MARK COMPLETE` (or `MARK FAILED`) acknowledgement back to the API.

### 3.2. `eqa-api` (Containerized PaaS / Node.js & Express)

- **Runtime Environment:** Containerized cloud platform (Red Hat OpenShift / Kubernetes) load-balanced across multiple pods (**Pod 11, Pod 12, Pod 13**).
- **Resource Throttling:** Strictly maintains an outbound database connection pool configured between **26 and 30 connections** to prevent connection starvation on the upstream IBM DB2 database.
- **Core Responsibilities:**

1. Exposes resilient, highly available REST endpoints for the asynchronous lifecycle.
2. Queries pending review cases from **DB2 MQA** (targeting initial state **K**).
3. Invocations to **T2/T16 Info Svc** protected via Circuit Breakers and robust error isolation.
4. Generates packaged JAR files and manages the decentralized state machine via `STATE.JSON` in **Amazon S3**.
5. Implements flat-memory streaming (`stream.pipeline`) to prevent container RAM saturation.

### 3.3. Storage Tier Architecture

- **Amazon S3 (`STATE.JSON` & WIP Work Files):**
- Acts as the decentralized checkpointing source of truth.
- Maintains run states (`P`, `R`, `S`, `W`/`D`) and transient object packages.

- **Driver Local Disk:** Target file system directory (`\samples\ssn...jar`) where the client materializes downloaded artifacts under strict backpressure.
- **IBM DB2 MQA:** Enterprise relational transactional store for initial record identification (State `K`).
- **WebSphere JEE & USS:** Legacy core application running on IBM WebSphere and z/OS Unix System Services (USS), interacting via shared DB2 tables.

---

## 4. End-to-End Asynchronous Execution Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Cron as Scheduler / Cron
    participant Driver as Windows Driver
    participant API as eqa-api (PaaS / Express)
    participant DB2 as IBM DB2 (MQA)
    participant T2T16 as T2/T16 Info Svc
    participant S3 as AWS S3 (STATE.JSON & JARs)
    participant Disk as Local Disk (Driver)

    Note over Cron,Driver: Phase 1: Initiation and Asynchronous Orchestration
    Cron->>Driver: Trigger scheduled execution
    Driver->>API: POST /start-processing { batchId }
    API-->>Driver: HTTP 202 Accepted (Immediate Response / Non-blocking)

    activate API
    API->>DB2: Query pending records (State: 'K')
    DB2-->>Result Set: [Sample / SSN List]
    API->>S3: Create/Update STATE.JSON (State: 'P' - Processing)

    API->>T2T16: Fetch Social Security Data (T2/T16)
    T2T16-->>API: Heavy Data Stream
    API->>S3: Stream Pipeline -> ssn.jar
    API->>S3: Update STATE.JSON (State: 'R' - Ready to Send)
    deactivate API

    Note over Driver,S3: Phase 2: Pull-Based Secure Transfer
    loop Polling Loop (Controlled Pull)
        Driver->>API: GET /ready-jars (SEND ME READY JAR FILES)
        API->>S3: Read STATE.JSON (Verify State 'R')
        API->>S3: Update STATE.JSON (State: 'S' - Sent to Driver)
        S3-->>API: ReadStream of ssn.jar
        API-->>Driver: Pipe Stream of ssn.jar (TCP Backpressure applied)
        Driver->>Disk: Write stream directly to \samples\ssn...jar
    end

    Note over Driver,API: Phase 3: Confirmation and Synchronization (ACK)
    Driver->>Disk: Verify physical write success
    Disk-->>Driver: Write Confirmed
    Driver->>API: POST /mark-complete (MARK WRITTEN)
    activate API
    API->>S3: Update STATE.JSON (Terminal State: 'W' / 'Done')
    API-->>Driver: 200 OK { status: "SYNCHRONIZED" }
    deactivate API

```

---

## 5. Interface & Message Contract Matrix

| Operation / Endpoint      | Sender (`From`) | Receiver (`To`) | Protocol / Transport | Request Payload                                   | Response Payload                           | Functional Description                                            |
| ------------------------- | --------------- | --------------- | -------------------- | ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| **`start-processing`**    | `Driver`        | `eqa-api`       | HTTP REST / POST     | `{"batchId": "B-9898", "sampleLimit": 40}`        | `{"status": "ACCEPTED", "runId": "R-101"}` | Triggers non-blocking background orchestration.                   |
| **`getStudies` (DB2)**    | `eqa-api`       | `DB2 MQA`       | TCP / SQL (Pool)     | `SELECT * FROM MQA WHERE STATUS = 'K'`            | Result set (`Study`, `Sample`, `SSN`)      | Queries unprocessed samples in state 'K'.                         |
| **`getDataForSSN`**       | `eqa-api`       | `T2/T16 Svc`    | HTTP REST / GET      | Param: `?ssn={ssn}`                               | `{"ssn": "...", "caseData": {}}`           | Retrieves SSN data required to build package jars.                |
| **`storeWkgFiles` (S3)**  | `eqa-api`       | `AWS S3`        | AWS SDK / HTTPS      | Binary object stream + `STATE.JSON`               | `{"etag": "...", "versionId": "..."}`      | Persists intermediate jar and updates decentralized states.       |
| **`ready-jars`** (Pull)   | `Driver`        | `eqa-api`       | HTTP REST / GET      | Route: `/ready-jars?batchId={id}`                 | Binary Stream (`*.jar`)                    | Requests ready files via polling; transitions state to 'S'.       |
| **`mark-complete`** (ACK) | `Driver`        | `eqa-api`       | HTTP REST / POST     | `{"runId": "R-101", "ssn": "...", "status": "W"}` | `{"status": "ACK", "synced": true}`        | Confirms successful local disk write; finalizes state as 'W'/'D'. |

---

## 6. Domain Model & State Machine

### 6.1. Decentralized State Machine (`STATE.JSON`)

The lifecycle of each individual record is controlled by explicit states mapped inside `STATE.JSON` on S3:

- **`K` (Not Processed):** Initial state residing in DB2 indicating cases pending collection.
- **`P` (Processing):** API has accepted the run and is actively communicating with T2/T16.
- **`R` (Ready to Send):** Artifacts generated and stored successfully in S3; awaiting driver polling.
- **`S` (Sent to Driver):** API is actively streaming the package to the client; locks concurrent duplication.
- **`W` / `D` (Written / Done):** Terminal state. Driver has confirmed successful local disk persistence.
- **`E` (Error) / `MARK FAILED`:** If client disk writing fails, the state reverts or flags as failed for retry safety.

### 6.2. System Roadmap & Compliance

| Milestone / Subsystem                      | Scheduled Target    | Description & Impact                                                       |
| ------------------------------------------ | ------------------- | -------------------------------------------------------------------------- |
| **Java 8 End-of-Life**                     | September 20, 2026  | Upstream Java runtime upgrades across supporting enterprise tooling.       |
| **Cobol 6 Migration**                      | August 14, 2026     | Mainframe Cobol compilation and interface update.                          |
| **POAMS MCS $\rightarrow$ CCE Transition** | Nov 2026 – Mar 2027 | Migration from legacy POAMS MCS packaging to CCE standard format (`.jar`). |
| **Laws Subsystem Decommission**            | January 2027        | Decommissioning of legacy Laws components and endpoints.                   |

### Operational Guardrails

1. **Connection Pool Cap:** Node.js DB2 clients maintain a strict ceiling of **30 connections** (operating range: 26–30) to preserve upstream database health.
2. **Worker Concurrency:** The Windows Driver is restricted to **2 concurrent workers** to manage network backpressure efficiently.
3. **Flat Memory Architecture:** All heavy payloads utilize Node.js `stream.pipeline` directly from T2/T16 to S3 and from S3 to Express HTTP responses, guaranteeing flat memory usage under high concurrency.
