1. **System Architecture Overview**
```mermaid
flowchart LR
  User[User UI<br/>Desktop / Browser / Mobile]
  Marketplace[Marketplace Sources<br/>MarketplaceSourceEntity]

  subgraph Hub[Friday Hub]
    APILayer[API Layer<br/>Gateway Service<br/>REST /v1 + WS /v1/ws]
    HubCore[Hub Core<br/>AuthN/AuthZ + Session Management + Dispatch]
    SkillRegistry[Skill Registry and Skill Store Service<br/>SkillManifestV2 + install/update/verify]
    WorkflowEngine[Workflow Engine<br/>Compile and Validate DAG + Scheduler]
    MemorySystem[Memory and State Service<br/>sessions + memory + diagnosis + audit]
    ConfigSystem[Config Manager<br/>HubSettingsEntity + ConfigRevisionEntity]
    ExtensionSystem[Extension System<br/>Plugin Runtime + Signed UI Modules]
    Queue[Dispatch and Outbox Queue<br/>OutboxMessageEntity]
    SQLite[(SQLite friday.db)]
  end

  subgraph Satellites[Satellites]
    Phone[phone]
    Desktop[desktop]
    RPi[rpi]
    Cloud[cloud-vm]
  end

  User <-->|commands and events| APILayer

  APILayer <--> HubCore
  APILayer <--> SkillRegistry
  APILayer <--> WorkflowEngine
  APILayer <--> MemorySystem
  APILayer <--> ConfigSystem
  APILayer <--> ExtensionSystem

  WorkflowEngine <--> SkillRegistry
  WorkflowEngine <--> MemorySystem
  WorkflowEngine <--> Queue
  ConfigSystem --> Queue
  ExtensionSystem --> SkillRegistry

  APILayer <-->|control + sync (WS/HTTP)| Phone
  APILayer <-->|control + sync (WS/HTTP)| Desktop
  APILayer <-->|control + sync (WS/HTTP)| RPi
  APILayer <-->|control + sync (WS/HTTP)| Cloud

  Queue <--> Phone
  Queue <--> Desktop
  Queue <--> RPi
  Queue <--> Cloud

  Marketplace --> SkillRegistry

  HubCore --> SQLite
  SkillRegistry --> SQLite
  WorkflowEngine --> SQLite
  MemorySystem --> SQLite
  ConfigSystem --> SQLite
  Queue --> SQLite
```
Shows the Hub-centered architecture with all required core systems, extension system, and satellite relationships.

2. **Skill Lifecycle Sequence Diagram**
```mermaid
sequenceDiagram
  autonumber
  participant Discovery as Discovery Sources
  participant Registry as SkillRegistry
  participant Loader as Skill Loader
  participant Normalizer as Manifest Normalizer
  participant Validator as Validation Pipeline
  participant Trust as Trust and Sandbox Policy
  participant Invoker as Intent Router or Workflow Scheduler
  participant Engine as Skill Engine
  participant Sandbox as Runtime Sandbox

  Note over Discovery: Precedence: extra < bundled < managed < agents-personal < agents-project < workspace
  Discovery->>Registry: discover skill candidates
  Registry->>Loader: load candidate files
  Loader->>Normalizer: parse raw skill.manifest.json (or legacy adapter)
  Normalizer->>Normalizer: applyManifestDefaults(raw) -> SkillManifestV2
  Normalizer->>Validator: normalized manifest

  Validator->>Validator: schema validate SkillManifestV2
  Validator->>Validator: required files and step graph checks
  Validator->>Validator: schema compile + engine compatibility checks
  Validator->>Validator: filesystem scope validation (pathPrefixes)

  alt validation fails
    Validator-->>Registry: reject (status error or not_installed)
  else validation passes
    Validator->>Trust: activation checks
    Trust->>Trust: trust tier verification (bundled/managed/workspace/extra)
    Trust->>Trust: choose execution mode (trusted/restricted/isolated)
    Trust->>Trust: permission policy checks (PermissionPolicyV2)

    alt trust or permission denied
      Trust-->>Registry: block activation
    else activation allowed
      Trust-->>Registry: register and activate manifest snapshot
      Invoker->>Registry: resolve skill for intent/workflow invocation
      Registry->>Engine: lazy-load skillId@version
      Engine->>Sandbox: start runtime boundary
      Engine->>Engine: init(ctx) -> SkillRunState

      loop execute turns
        Engine->>Sandbox: execute(ctx)
        Sandbox-->>Engine: SkillExecutionResult (messages/tools/output)
      end

      Note over Engine: teardown reason is completed, failed, or cancelled
      Engine->>Sandbox: teardown(reason)
      Sandbox-->>Engine: teardown ok
      Engine-->>Registry: persist run state and emit telemetry
    end
  end
```
Shows discovery through teardown, including manifest defaulting, schema validation, trust checks, and runtime execution.

3. **Onboarding Skill Flow**
```mermaid
sequenceDiagram
  autonumber
  participant User
  participant Onboarding as Onboarding Skill
  participant AI as Inference Model
  participant Validator as FridaySchema.safeParse
  participant Config as Config Apply Pipeline

  Note over Onboarding: Step 1 welcome_profile<br/>Entry: skill started<br/>Exit: name + experienceLevel captured
  Onboarding->>User: collect profile (max attempts and defaults)

  Note over Onboarding: Step 2 goal_capture<br/>Entry: profile complete<br/>Exit: goals list captured (minimum 1 or fallback)
  Onboarding->>User: collect goals and priorities

  Note over Onboarding: Step 3 workflow_inventory<br/>Entry: goals captured<br/>Exit: workflowsToday mapped (or skip with note)
  Onboarding->>User: collect workflows and pain points

  Note over Onboarding: Step 4 constraints_capture<br/>Entry: workflows done<br/>Exit: constraints captured (optional defaults)
  Onboarding->>User: collect constraints and preferences

  Note over Onboarding: Step 5 intent_inference<br/>Entry: constraints done<br/>Exit: inferredIntent produced
  Onboarding->>AI: infer summary + success signals + confidence
  AI-->>Onboarding: inferredIntent

  Note over Onboarding: Step 6 intent_confirmation<br/>Entry: inference done<br/>Exit: user confirmed or edited intent
  Onboarding->>User: confirm/edit/skip inferred intent

  Note over Onboarding: Step 7 config_draft<br/>Entry: intent confirmed<br/>Exit: schema-valid configPatch draft
  Onboarding->>Validator: validate configPatch
  Validator-->>Onboarding: valid or errors

  Note over Onboarding: Step 8 config_confirm_apply<br/>Entry: draft ready<br/>Exit: final OnboardingOutput
  Onboarding->>User: present summaryForUser + configPatch

  alt user approves
    User-->>Onboarding: approve
    Onboarding->>Config: draft_patch
    Config->>Validator: validate patch
    Validator-->>Config: ok
    Config->>Config: backup config.json5
    Config->>Config: apply merge_patch
    Config->>Validator: reload and verify
    alt verification passes
      Validator-->>Config: ok
      Config-->>Onboarding: applied
      Onboarding-->>User: onboarding complete + final config
    else verification fails
      Validator-->>Config: verification error
      Config->>Config: rollback_on_fail
      Config-->>Onboarding: rolled back
      Onboarding-->>User: report failure and next edits
    end
  else user rejects
    User-->>Onboarding: reject
    Onboarding->>Onboarding: restart from config_draft
  end

  Note over Onboarding,User: Global fallback rule: max attempts per step, then skip/default with explicit summary note.
```
Shows all onboarding steps with entry/exit criteria and the final config generation/apply/rollback pipeline.

4. **Self-Learning Skill Flow**
```mermaid
flowchart TD
  Event[LearningEvent received] --> Ingest[ingest_event<br/>normalize + dedupe by eventId]
  Ingest --> Extract[signal_extract<br/>deterministic extractSignals(event)]
  Extract --> Route{signal type}

  subgraph Learn["Learn"]
    Route -->|preference or correction| FactUpdate[fact_update<br/>UPSERT preference_facts]
    Route -->|error| Incident[incident_classify<br/>create error_incidents with signature]
    Incident --> Pattern[pattern detection<br/>computeIncidentSignature + recurrence]
    Incident --> Diagnosis[diagnosis_records and learned_lessons update]
  end

  subgraph Fix["Fix"]
    Pattern --> Plan[autofix_plan<br/>create AutoFixAction with riskTier]
    Plan --> Tier{riskTier}
    Tier -->|0 or 1| ExecLow[autofix_execute<br/>auto apply with rollback guard]
    Tier -->|2| Approval[create ApprovalRequestEntity<br/>status pending]
    Approval --> UserGate{approve?}
    UserGate -->|approved| ExecHigh[execute Tier-2 action]
    UserGate -->|rejected or expired| Reject[mark action rejected or expired]
  end

  subgraph Memory["Memory"]
    FactUpdate --> Persist[memory_persist<br/>transactional durable write]
    Diagnosis --> Persist
    ExecLow --> Persist
    ExecHigh --> Persist
    Reject --> Persist
    Persist --> Tables[(SQLite: learning_events, preference_facts, error_incidents, diagnosis_records, learned_lessons, auto_fix_actions, approval_requests)]
    Persist --> Score[quality_score_update<br/>learning_metrics]
  end

  Score --> Loop[Learn/Fix/Memory cycle continues]
  Loop --> Event
```
Shows the end-to-end learning cycle from event ingestion through risk-tiered auto-fix and persistence.

5. **Workflow Builder Skill Flow**
```mermaid
sequenceDiagram
  autonumber
  participant User
  participant Builder as Workflow Builder Skill
  participant Planner as Structured Decomposer
  participant Validator as WorkflowSpecV1 Validator
  participant Engine as WorkflowEngine.simulate
  participant Compiler as Workflow Compiler
  participant Store as workflow_versions

  User->>Builder: describe requirement + concrete example
  Builder->>Builder: need_capture
  Builder->>Builder: trigger_define
  Builder->>Builder: io_define (inputs and outputs)

  Builder->>Planner: logic_decompose into steps and decisions
  Planner-->>Builder: structured step draft

  Builder->>Builder: exception_design (retry/fallback/approval/errorPolicy)
  Builder->>Builder: spec_generate to WorkflowSpecV1

  Builder->>Validator: validate(WorkflowSpecV1)
  alt invalid
    Validator-->>Builder: validation errors
    Builder->>Planner: refine decomposition
    Planner-->>Builder: updated draft
    Builder->>Validator: re-validate
  else valid
    Validator-->>Builder: valid
    Builder->>Builder: test_generate (at least 3 tests with mocks/assertions)
    Builder->>Engine: simulate(spec, inputs)
    Engine-->>Builder: SimulationResult
    Builder->>User: simulation_review + publish prompt

    alt user approves publish
      User-->>Builder: publish
      Builder->>Compiler: compile WorkflowSpecV1 to CompiledWorkflowGraphV2
      Compiler->>Store: persist immutable graph + checksum
      Store-->>Builder: workflowVersionId
      Builder-->>User: published workflowVersionId
      opt execute now
        Builder->>Engine: start(workflowVersionId, inputs)
        Engine-->>Builder: WorkflowRun(status queued)
        Builder-->>User: runId
      end
    else user requests edits
      User-->>Builder: revise
      Builder->>Planner: iterate decomposition
    end
  end
```
Shows requirement capture to `WorkflowSpecV1`, compilation to `CompiledWorkflowGraphV2`, validation loops, and execution handoff.

6. **Workflow Engine Sequence Diagram**
```mermaid
sequenceDiagram
  autonumber
  participant Client
  participant Compiler
  participant Engine
  participant RunStore as WorkflowRunEntity Store
  participant Scheduler
  participant NodeExec as Node Executor
  participant Approval
  participant Compensation

  Client->>Compiler: submit WorkflowSpecV1
  Compiler->>Compiler: validate DAG + refs + failure policy
  Compiler-->>Client: CompiledWorkflowGraphV2 + workflowVersionId

  Client->>Engine: start(workflowVersionId, triggerPayload)
  Engine->>RunStore: create run status queued
  Engine->>RunStore: transition queued -> running

  loop node scheduling cycle
    Engine->>Scheduler: get ready nodes
    Scheduler->>NodeExec: dispatch attempts
    NodeExec-->>Engine: node result

    alt node succeeded
      Engine->>RunStore: persist node attempt completed
    else node failed
      Engine->>RunStore: persist node attempt failed

      alt onFailure = fail_fast
        Engine->>RunStore: transition running -> failed
      else onFailure = continue_on_error
        Engine->>Engine: continue scheduling remaining nodes
      else onFailure = fallback_step
        Engine->>Engine: enqueue fallbackStepId and continue running
      else onFailure = compensate
        Engine->>RunStore: transition running -> compensating
        Engine->>Compensation: trigger compensation workflow
      else onFailure = pause_for_approval
        Engine->>RunStore: transition running -> pausing
        Engine->>Approval: create approval gate
        Approval-->>Engine: pause acknowledged
        Engine->>RunStore: transition pausing -> paused
      end
    end
  end

  opt resume paused run
    Client->>Engine: resume(runId)
    Engine->>RunStore: transition paused -> running
  end

  opt cancel request
    Client->>Engine: cancel(runId)
    Engine->>RunStore: transition running or pausing or paused -> cancelled
  end

  alt final outcome no failures
    Engine->>RunStore: transition running -> completed
  else final outcome partial failures
    Engine->>RunStore: transition running -> failed
  else compensation finished
    Engine->>RunStore: transition compensating -> completed or failed
  end

  Note over RunStore: WorkflowRunStatus states: queued, running, pausing, paused, compensating, completed, failed, cancelled
```
Shows compile/validate/execute flow, all eight `WorkflowRunStatus` states, and failure policy branching.

7. **Memory System Data Flow**
```mermaid
flowchart LR
  subgraph Capture["Capture"]
    Msg[session.message.appended<br/>SessionMessageEntity]
    Node[workflow node outcomes<br/>WorkflowRunNodeAttemptEntity]
    LearnEvt[SelfLearning LearningEvent]
  end

  subgraph Process["Embed + Normalize"]
    Normalize[normalize + namespace tagging<br/>global/workflow/run/session]
    EmbedReq[EmbeddingRequest]
    EmbedRes[EmbeddingResponse.vectors]
  end

  subgraph Storage["SQLite Storage"]
    S1[(session_messages)]
    S1F[(session_messages_fts)]
    S2[(memory_items<br/>embedding_vector_ref)]
    S3[(learning_events)]
    S4[(preference_facts)]
    S5[(error_incidents)]
    S6[(diagnosis_records)]
    S7[(learned_lessons)]
    S8[(auto_fix_actions)]
    S9[(approval_requests)]
  end

  subgraph Retrieval["Retrieval"]
    Query[context query by user/session/workflow]
    Keyword[keyword retrieval<br/>FTS on session_messages_fts]
    Vector[embedding retrieval<br/>memory_items + vector refs]
    Merge[hybrid ranking and merge]
    Context[resolved context packet to Skills and Workflow Engine]
  end

  Msg --> Normalize
  Node --> Normalize
  LearnEvt --> Normalize

  Normalize --> S1
  S1 --> S1F
  Normalize --> EmbedReq --> EmbedRes --> S2
  Normalize --> S3
  Normalize --> S4
  Normalize --> S5
  S5 --> S6 --> S7
  S5 --> S8 --> S9

  Query --> Keyword --> Merge
  Query --> Vector --> Merge
  S1F --> Keyword
  S2 --> Vector
  S4 --> Vector
  S7 --> Vector
  Merge --> Context

  Context --> Persist[Cross-session persistence<br/>canonical sessionKey + durable local SQLite]
```
Shows event capture to embedding/storage and hybrid retrieval, with explicit SQLite tables and cross-session persistence.

8. **Hub-Satellite Communication**
```mermaid
sequenceDiagram
  autonumber
  participant Sat as Satellite
  participant Hub as Hub Gateway
  participant UI as Operator UI
  participant Sec as Security Service
  participant Queue as Outbox Queue
  participant WFE as Workflow Engine

  Sat->>Sat: generate identity key pair
  Sat->>Hub: PairingRequest(identityPubKey, capabilities, nonce)
  Hub->>UI: satellite.pairing.requested(code, metadata)
  UI->>Hub: approve pairing
  Hub->>Sec: issue scoped satellite token + hub key material
  Sec-->>Hub: token + signature
  Hub-->>Sat: PairingApproved(hubPubKey, token, signature)

  Sat->>Hub: Connect(authToken, signedChallenge, ephPubKey, supportedAlgorithms)
  Hub-->>Sat: ConnectOk(serverEphPubKey, encryptedSessionParams.algorithm)
  Note over Sat,Hub: EncryptedPayloadEnvelope on payload channel (XChaCha20-Poly1305 or AES-256-GCM)

  loop heartbeat every interval
    Sat->>Hub: heartbeat(ts,status,metrics,queueDepth,activeRuns)
    Hub-->>Sat: accepted + expectedIntervalMs
  end

  WFE->>Queue: enqueue task dispatch
  Queue->>Hub: queued message
  Hub-->>Sat: encrypted command frame
  Sat->>Sat: execute locally
  Sat->>Hub: sync/push (acks, nodeResults, localEvents)
  Hub->>Queue: ack or retry or dead_letter
  Hub-->>WFE: result collection and run events

  alt disconnect or relay failure
    Sat->>Sat: offline mode + local queue
    Sat->>Sat: reconnect backoff (5s base, 5m max)
    Sat->>Hub: Resume(lastAckedSeq, streamId, epoch, cursor)
    alt epoch and cursor valid
      Hub-->>Sat: replay missing events + config diffs + redelivery
    else stale epoch or invalid resume
      Hub-->>Sat: STREAM_EPOCH_STALE and full resubscribe required
      Sat->>Hub: HTTP fallback sync/pull + sync/push
    end
  end
```
Shows registration, encrypted channel setup, heartbeat, dispatch/result loops, and reconnect/failover behavior.

9. **Permission and Trust Model**
```mermaid
flowchart TD
  Manifest[SkillManifestV2 + SkillSource/SkillOrigin] --> TierAssign[Assign SkillTrustTier]
  TierAssign --> SandboxPolicy[SkillSandboxPolicy<br/>defaultExecutionMode + allowedExecutionModes]
  SandboxPolicy --> ModeSelect[Select SkillExecutionMode]

  Manifest --> PermPolicy[PermissionPolicyV2<br/>grants + promptOn]
  PermPolicy --> Eval[Permission Evaluator<br/>deny by default]
  Eval --> Required{required grants satisfied?}

  Required -->|no| Deny[Deny and emit security.permission.denied]
  Required -->|yes| Prompt{resource in promptOn?}
  Prompt -->|yes| RuntimePrompt[Runtime permission prompt]
  RuntimePrompt -->|rejected| Deny
  Prompt -->|no| DispatchGate[Execution gate]
  RuntimePrompt -->|approved| DispatchGate

  SatTrust[SatelliteEntity.trustLevel<br/>restricted or trusted] --> DispatchGate
  ModeSelect --> DispatchGate
  DispatchGate --> Enforce[Sandbox enforcement]

  Enforce --> FSGuard[filesystem selectors<br/>pathPrefixes]
  Enforce --> NetGuard[network selectors<br/>hostAllowlist]
  Enforce --> ToolGuard[tool/shell selectors<br/>toolAllowlist + commandAllowlist]
  FSGuard --> Audit[audit_logs]
  NetGuard --> Audit
  ToolGuard --> Audit
  Deny --> Audit

  subgraph Matrix["SkillTrustTier x SkillExecutionMode"]
    M1[bundled<br/>default trusted<br/>allowed trusted]
    M2[managed<br/>default restricted<br/>allowed restricted or isolated]
    M3[workspace<br/>default isolated<br/>allowed isolated]
    M4[extra<br/>default isolated<br/>allowed isolated]
  end

  TierAssign --> M1
  TierAssign --> M2
  TierAssign --> M3
  TierAssign --> M4
```
Shows trust tier assignment, permission evaluation, sandbox enforcement, and the trust tier/execution mode matrix.

10. **Self-Evolution Loop**
```mermaid
flowchart LR
  Observe[Observe<br/>capture events from conversations, tools, workflow runs, failures]
  Learn[Learn<br/>extract signals and build facts/incidents]
  Decide[Decide<br/>rank adaptations by confidence and risk tier]
  Act[Act<br/>apply AutoFixAction]
  Evaluate[Evaluate<br/>compare pre/post metrics and detect regressions]
  Consolidate[Consolidate<br/>merge duplicates, decay stale prefs, persist policy state]

  Observe --> Learn --> Decide --> Act --> Evaluate --> Consolidate --> Observe

  Decide --> TierGate{risk tier}
  TierGate -->|Tier 0 or 1| AutoPath[automatic execution with rollback transaction]
  TierGate -->|Tier 2| Approval[ApprovalRequestEntity pending]
  Approval --> UserDecision{approved?}
  UserDecision -->|yes| AutoPath
  UserDecision -->|no or expired| Skip[reject or expire action]
  AutoPath --> Act
  Skip --> Consolidate

  Evaluate --> Regression{metric degradation beyond threshold?}
  Regression -->|yes| Rollback[auto rollback + log outcome]
  Regression -->|no| Commit[commit adaptation]
  Rollback --> Consolidate
  Commit --> Consolidate

  subgraph Guardrails["Guardrails"]
    G1[evidence gate: minimum evidence_count and confidence with source traceability]
    G2[additive rule: explicit user settings always win]
    G3[hard stop: rollback rate > 30 percent in 24h]
    G4[hard stop: error spike > 3x baseline in 1h]
    G5[hard stop: unresolved high severity incident > 48h]
  end

  Learn --> G1
  Decide --> G2
  Evaluate --> G3
  Evaluate --> G4
  Evaluate --> G5

  G3 --> Pause[pause Tier-1 auto-fixes and alert user]
  G4 --> Pause
  G5 --> Pause
  Pause --> Decide
```
Shows the full observe-learn-decide-act-evaluate cycle with approval gates and hard-stop guardrails.
