# Process Documentation: eQA-API System

## 1. Introduction and Architectural Overview

The **eQA-API** system is the enterprise batch orchestration platform responsible for gathering, processing, and distributing support material packages for Social Security Numbers (**SSNs**) under quality assurance frameworks.

```mermaid
flowchart TB
    subgraph Execution_Layer["Client Execution Layer"]
        Cron["Cron / Task Scheduler"]
        Driver["Windows Driver (Node.js)<br/>• 2 Concurrent Workers<br/>• Polling & Sync Loop"]
    end

    subgraph PaaS_Layer["API Orchestration Layer (PaaS)"]
        LB["Load Balancer / Ingress"]
        API["eqa-api (Node.js / Express)<br/>DB2 Pool (26-30 connections)"]
    end

    subgraph Storage_Tier["Storage & State Tier"]
        S3["AWS S3 (STATE.JSON & WIP)"]
        Disk["Local Disk (Driver)<br/>(\\samples\\ssn...jar)"]
    end

    subgraph Enterprise_Data["Data & Legacy Tier"]
        DB2[("IBM DB2 (MQA)<br/>• Initial State 'K'")]
        T2T16["T2/T16 Info Service<br/>• SSN Records & Data"]
    end

    Cron -->|"1. Trigger"| Driver
    Driver -->|"2. HTTP Calls"| LB
    LB --> API
    API -->|"3. Query cases"| DB2
    API -->|"4. Fetch data"| T2T16
    API -->|"5. Manage State"| S3
    S3 -.->|"6. Stream Files"| Driver
    Driver -->|"7. Physical Write"| Disk

```

---

## 2. Step-by-Step Operational Flow & Integrated Diagrams

### Step 1: Start Processing

The workflow starts when the scheduler triggers the `Driver`, which issues an asynchronous non-blocking request to the API.

```mermaid
sequenceDiagram
    autonumber
    actor Cron as Scheduler
    participant Driver as Windows Driver
    participant API as eqa-api (Express)

    Cron->>Driver: Trigger scheduled batch
    Driver->>API: POST /start-processing { batchId }
    API-->>Driver: HTTP 202 Accepted (Non-blocking response)

```

### Step 2: Database Query (`Get Work from DB`)

The API queries IBM DB2 to retrieve eligible study and sample records marked with the initial status **`K`**.

- **Sample Database JSON Payload Structure:**

```json
[
  {
    "clmssn": "001020003",
    "sample-id": "SS1202612"
  }
]
```

### Step 3: State Reconciliation (`Determine What to Do / Reconcile`)

Before heavy processing, the API cross-references DB2 work items against the decentralized `STATE.JSON` file in AWS S3.

```mermaid
flowchart TD
    Start([Start Reconciliation]) --> Loop[For each clmssn in workFromDb]
    Loop --> CheckExists{does sampleId & clmssn<br/>exist in STATE.JSON?}
    CheckExists -- No --> Process[Schedule for Processing]
    CheckExists -- Sí --> CheckStatus{Is status 'P'<br/>and expired?}
    CheckStatus -- Yes --> Process
    CheckStatus -- No --> Skip[Skip / Already Processed]
    Process --> End([Update States on S3])
    Skip --> Loop

```
