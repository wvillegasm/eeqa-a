# Architecture & Technical Specification Document: eQA-API System

## 1. Executive Summary & Scope

The **eQA System** is an enterprise batch-processing and workflow orchestration platform responsible for gathering, processing, generating support material packages, and updating case states associated with Social Security Numbers (**SSNs**) under the quality assurance review framework (**eQA / MQA**).

This document formalizes the architectural whiteboard specifications into an enterprise-grade technical standard. It establishes component boundaries, synchronous and asynchronous communication flows, intermediate and long-term storage mechanisms, data models, and API messaging contracts.

---

## 2. System Architecture (C4 Container Diagram)

The system is distributed across an on-premises/virtualized Windows environment, a containerized Platform-as-a-Service (PaaS) cluster, AWS cloud services, and legacy enterprise Mainframe subsystems.

```mermaid
flowchart TB
    subgraph Execution_Layer["Batch Execution & Scheduling Layer"]
        Cron["Cron / Task Scheduler"]
        Driver["Driver Daemon / Worker<br/>(Node.js on Windows Server)<br/>• 2 Concurrent Workers<br/>• Thread Loop / Status Polling<br/>• Target: ~40 Support Materials/Run"]
    end

    subgraph PaaS_Layer["API & Orchestration Layer (PaaS / OpenShift)"]
        LB["Ingress / Load Balancer"]
        Pod11["Pod 11: eqa-api<br/>(Node.js / Express)"]
        Pod12["Pod 12: eqa-api<br/>(Node.js / Express)"]
        Pod13["Pod 13: eqa-api<br/>(Node.js / Express)"]
        Pool["DB Connection Pool<br/>(Strict 26–30 connections)"]
    end

    subgraph Intermediate_Storage["Cloud Working Storage (WIP)"]
        S3["AWS S3 Bucket (Working Files / WIP)<br/>Key: study/sample/status/expdt/ssn/"]
    end

    subgraph Network_Storage["Enterprise File Distribution"]
        NFS["NFS Network Share<br/>(/Sample Run ID/Support Material/mcs/)<br/>Artifacts: *.jar, *.xml, *.fw"]
    end

    subgraph Enterprise_Data["Enterprise & Legacy Data Tier"]
        DB2[("IBM DB2 (MQA)<br/>• Studies, Samples & Cases<br/>• Status Tracking & Audit Logs")]
        T2T18["T2T18 Info Service (AWS)<br/>• SSN Case Data<br/>• Historical Archived Data"]
        WebSphere["eQA Enterprise Subsystem<br/>(IBM WebSphere JEE)"]
        USS["USS (Unix System Services)<br/>(z/OS Mainframe Storage)"]
    end

    %% Execution Flows
    Cron -->|"1. Scheduled Trigger"| Driver
    Driver -->|"2. POST /start (Batch ID, Run Options)"| LB
    LB --> Pod11
    LB --> Pod12
    LB --> Pod13

    Pod11 --> Pool
    Pod12 --> Pool
    Pod13 --> Pool

    Pool -->|"3. Query: getStudies (Case Support Material)"| DB2
    Pod12 -->|"4. getDataForSSN / getArchivedData"| T2T18
    Pod12 -->|"5. Store WIP Objects (storeWkgFiles)"| S3
    Pool -->|"6. updateStatus (Study, Sample, SSN)"| DB2

    Driver -->|"7. GET /finished-work (Polling loop)"| LB
    Driver -->|"8. writeWork (*.jar, *.xml, *.fw)"| NFS
    Driver -->|"9. POST /transferred (ACK / Close Run)"| LB
    LB -->|"10. Final State Commit (Status: C)"| DB2

    %% Legacy Integrations
    WebSphere -.->|"Read/Write Shared Tables"| DB2
    WebSphere -.->|"Mainframe File I/O"| USS
```

---

## 3. Component Boundaries and Responsibilities

### 3.1. `Driver` (Windows Server & Node.js)

- **Runtime Environment:** Windows Server host executing a Node.js process runtime.
- **Activation:** Triggered periodically via a `Cron` daemon or scheduled enterprise batch scheduler passing a unique `batchID`.
- **Concurrency Model:** Configured to run **2 worker threads/loops** concurrently, orchestrating batches containing approximately **40 support material packages** per execution.
- **Core Responsibilities:**
  1. Issues the initial `start` signal to `eqa-api`.
  2. Executes an active polling loop (`loop thread / get finished work`) monitoring run completion.
  3. Retrieves the processed artifacts from the API once ready.
  4. Writes and packages the files directly into the target **NFS network share** (`write work`).
  5. Emits the final `transferred` completion signal back to `eqa-api`.

### 3.2. `eqa-api` (Containerized PaaS / Node.js & Express)

- **Runtime Environment:** Containerized cloud platform (Red Hat OpenShift / Kubernetes) load-balanced across multiple pods (**Pod 11, Pod 12, Pod 13**).
- **Resource Throttling:** Strictly maintains an outbound database connection pool configured between **26 and 30 connections** to prevent connection starvation on the upstream IBM DB2 database.
- **Core Responsibilities:**
  1. Exposes the operational REST endpoints (`/start`, `/finished-work`, `/transferred`).
  2. Queries pending review studies and sample populations from **DB2 MQA**.
  3. Queries the **T2T18 Info Service** in AWS for SSN-level case records and archived historical documents.
  4. Buffers intermediate work-in-progress files (**WIP**) into **Amazon S3**.
  5. Updates operational processing flags and state transitions in **DB2 MQA**.

### 3.3. Storage Tier Architecture

- **Amazon S3 (`Store Working Files`):**
  - Serves as an ephemeral/intermediate working area for in-flight case compilation.
  - Hierarchical object key scheme:
    ```text
    s3://[bucket-name]/studies/{studyId}/samples/{sampleId}/status/{status}/expdt/{expDate}/ssn/{ssn}/wip_data.bin
    ```
- **NFS (Network File System):**
  - Target durable network repository accessible by downstream enterprise consumers:
    ```text
    /mnt/nfs/sample_runs/{batchId}/
       └── support_material/
           └── mcs/
               ├── {ssn}.jar
               ├── {ssn}_cce.jar
               ├── manifest.xml
               └── status.fw
    ```
- **IBM DB2 MQA:** Enterprise relational transactional store for studies, samples, case records, and run status indicators.
- **WebSphere JEE & USS:** Legacy core application running on IBM WebSphere and z/OS Unix System Services (USS), interacting via shared DB2 tables.

---

## 4. End-to-End Execution Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Cron as Scheduler / Cron
    participant Driver as Driver (Win/NodeJS)
    participant API as eqa-api (PaaS / Express)
    participant DB2 as IBM DB2 (MQA)
    participant T2T18 as T2T18 Info Svc (AWS)
    participant S3 as AWS S3 Storage
    participant NFS as NFS Target Share

    Note over Cron,Driver: Batch Initialization Trigger
    Cron->>Driver: Trigger scheduled execution (batchId)
    Driver->>API: POST /api/v1/run/start { batchId, options }
    API-->>Driver: 200 OK { status: "ACCEPTED", runId: "RUN-1001" }

    activate API
    API->>DB2: getStudies (Fetch pending case support materials)
    DB2-->>API: Result Set: [Study, Sample, SSN list]

    loop For each SSN in Sample (Processed via Connection Pool)
        API->>T2T18: getDataForSSN(ssn) & getArchivedData(ssn)
        T2T18-->>API: SSN Case Payload & Archived Documents
        API->>S3: putObject(storeWkgFiles - WIP Key Structure)
        S3-->>API: 200 PutObject Success
        API->>DB2: updateStatus(SSN, status: "G")
    end
    deactivate API

    Note over Driver,API: Worker Polling Loop (2 Concurrent Workers)
    loop Polling until run completes
        Driver->>API: GET /api/v1/run/{runId}/finished-work
        alt Work Still In Progress
            API-->>Driver: 202 Accepted { status: "PROCESSING", pending: N }
        else Work Completed
            API-->>Driver: 200 OK { status: "READY", artifacts: [ ... ] }
        end
    end

    Note over Driver,NFS: Materialization & Network Persistence
    Driver->>NFS: writeWork (Write .jar, .xml, .fw per SSN)
    NFS-->>Driver: I/O Write Confirmation

    Driver->>API: POST /api/v1/run/{runId}/transferred { status: "C" }
    activate API
    API->>DB2: updateStatus(Run & Cases, status: "C")
    DB2-->>API: SQL Rows Updated
    API-->>Driver: 200 OK { status: "COMPLETED" }
    deactivate API
```

---

## 5. Interface & Message Contract Matrix

The following contract matrix formalizes the interface control table outlined on the project whiteboard:

| Step / Operation      | Sender (`From`) | Receiver (`To`) | Protocol / Transport | Request Payload                                  | Response Payload                                 | Functional Description                                           |
| :-------------------- | :-------------- | :-------------- | :------------------- | :----------------------------------------------- | :----------------------------------------------- | :--------------------------------------------------------------- |
| **`start`**           | `Driver`        | `eqa-api`       | HTTP REST / POST     | `{"batchId": "B-9898", "sampleLimit": 40}`       | `{"status": "OK", "runId": "R-101"}`             | Initiates case extraction and orchestrates workers.              |
| **`get Studies`**     | `eqa-api`       | `DB2 MQA`       | TCP / SQL (Pool)     | `SELECT * FROM MQA_STUDIES WHERE STATUS = 'P'`   | Result set of records (`Study`, `Sample`, `SSN`) | Queries pending review studies and support material cases.       |
| **`getDataForSSN`**   | `eqa-api`       | `T2T18 Svc`     | HTTP REST / GET      | Param: `?ssn={ssn}&includeArchived=true`         | `{"ssn": "...", "caseData": {}, "docs": []}`     | Retrieves case data and archived records from AWS.               |
| **`storeWkgFiles`**   | `eqa-api`       | `AWS S3`        | AWS SDK / HTTPS      | Binary object stream (`wip_data.bin`)            | `{"etag": "...", "versionId": "..."}`            | Persists temporary working files under the S3 WIP key prefix.    |
| **`updateStatus`**    | `eqa-api`       | `DB2 MQA`       | SQL UPDATE           | `UPDATE SAMPLES SET STATUS = :st WHERE ID = :id` | `{"rowsAffected": 1}`                            | Updates record state transition in the database.                 |
| **`getFinishedWork`** | `Driver`        | `eqa-api`       | HTTP REST / GET      | Route: `/runs/{runId}/finished-work`             | `{"status": "READY", "files": [...]}`            | Delivers metadata, manifests, and pointers to ready files.       |
| **`writeWork`**       | `Driver`        | `NFS`           | POSIX File I/O       | Binary streams: `{ssn}.jar`, `manifest.xml`      | Disk write confirmation (`void`)                 | Materializes packaged `.jar` and `.xml` files into the NFS tree. |
| **`transferred`**     | `Driver`        | `eqa-api`       | HTTP REST / POST     | `{"runId": "R-101", "status": "C", "files": 40}` | `{"status": "ACK", "closedAt": 1774213900}`      | Confirms all files were written to NFS; flags run as complete.   |

---

## 6. Domain Model & State Machine

### 6.1. Domain Hierarchy ($1:N$)

The relationship between quality control entities follows a strict one-to-many hierarchy:

$$\text{Study} \xrightarrow{1:N} \text{Sample} \xrightarrow{1:N} \text{SSN (Individual Case)}$$

```mermaid
erDiagram
    STUDY ||--o{ SAMPLE : contains
    SAMPLE ||--o{ SSN_RECORD : contains

    STUDY {
        string study_id PK
        string study_name
        date scheduled_date
        string status
    }

    SAMPLE {
        string sample_id PK
        string study_id FK
        string run_id
        string sample_type
    }

    SSN_RECORD {
        string ssn PK
        string sample_id FK
        string processing_status "C, E, G, I, K, N, P"
        string s3_wip_path
        string nfs_target_path
        timestamp updated_at
    }
```

### 6.2. Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> P : Batch Enqueued

    state "P (Pending)" as P
    state "G (Generate)" as G
    state "C (Complete)" as C
    state "E (Error)" as E
    state "I (Incomplete)" as I
    state "K (CCE Ind)" as K
    state "N (Not Available)" as N

    P --> G : eqa-api starts extraction

    G --> C : All files fetched & written to NFS
    G --> E : Network failure / Unhandled exception
    G --> I : Partial documentation returned
    G --> K : CCE conflict indicator detected
    G --> N : Record missing in T2T18 / Mainframe

    E --> P : Retry mechanism (Exponential backoff)
    I --> G : Re-fetch missing segments
    K --> [*] : Requires manual conflict review
    N --> [*] : Audit log recorded
    C --> [*] : Run concluded
```

### 6.3. Status Dictionary

- **`P` (Pending):** Record identified and queued for extraction.
- **`G` (Generate):** Active fetching from T2T18 and intermediate compilation in S3 WIP.
- **`C` (Complete):** Successfully generated, transferred, and written to NFS.
- **`E` (Error):** Communication failure, database timeout, or unrecoverable error.
- **`I` (Incomplete):** Partial documents retrieved; case missing mandatory exhibits.
- **`K` (CCE Ind):** Case flagged with a CCE conflict indicator (requires conflict resolution workflow).
- **`N` (Not Available):** No active case data or historical archives found for the SSN.

---

## 7. Infrastructure & Decommissioning Roadmap

| Milestone / Subsystem                      | Scheduled Target    | Description & Impact                                                       |
| :----------------------------------------- | :------------------ | :------------------------------------------------------------------------- |
| **Java 8 End-of-Life**                     | September 20, 2026  | Upstream Java runtime upgrades across supporting enterprise tooling.       |
| **Cobol 6 Migration**                      | August 14, 2026     | Mainframe Cobol compilation and interface update.                          |
| **POAMS MCS $\rightarrow$ CCE Transition** | Nov 2026 – Mar 2027 | Migration from legacy POAMS MCS packaging to CCE standard format (`.jar`). |
| **Laws Subsystem Decommission**            | January 2027        | Decommissioning of legacy Laws components and endpoints.                   |
| **Regional Office Realignment**            | Ongoing             | Dynamic routing changes for study samples across regional data offices.    |

### Operational Guardrails

1. **Connection Pool Cap:** Node.js DB2 clients must maintain a hard ceiling of **30 connections** (nominal operating range: 26–30) to preserve DB2 stability.
2. **Worker Concurrency:** The Windows Driver process is constrained to **2 concurrent worker loops** to avoid saturating I/O operations on the NFS share.
3. **S3 Cleanup Policy:** Configure S3 Lifecycle Policies on the WIP bucket prefix to expire working files after 7 days post-run completion.
