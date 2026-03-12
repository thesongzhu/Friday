# RFC: Friday Desktop Control Runtime

**Status:** Draft  
**Author:** Friday Platform Team  
**Created:** 2026-02-23  
**Tickets:** FRI-PLAT-071, FRI-PLAT-072, FRI-PLAT-073

---

## 1. Summary

The Desktop Control Runtime (DSK) provides controlled desktop automation across macOS, Windows, and Linux. It exposes a unified action model for clicking, typing, scrolling, dragging, screenshots, element inspection, app lifecycle, clipboard, and file operations — all gated by a multi-layer permission model and an auditable policy pack. An integrated action recorder captures user interactions, parameterizes them, and stores them as reusable sequences for replay.

## 2. Motivation

Friday agents today can control browsers and execute shell commands, but have no structured way to:

1. **Interact with native desktop applications** — GUI automation (clicking buttons, reading UI elements, launching apps) requires platform-specific accessibility APIs.
2. **Enforce safety boundaries on desktop actions** — clicking "Delete" in Finder or typing credentials into a dialog carry risk that must be gated.
3. **Record and replay desktop workflows** — users frequently repeat multi-step GUI tasks that could be captured and automated.
4. **Provide cross-platform consistency** — macOS, Windows, and Linux each expose different automation APIs (AppleScript/Accessibility API, COM/UI Automation, xdotool/AT-SPI).

The Desktop Control Runtime addresses these gaps with a unified adapter architecture, policy-driven safety layer, and recording subsystem.

## 3. Goals and Non-Goals

### Goals

- Desktop action success rate > 95% in supported applications (measured per-platform golden suite).
- Unsafe action block rate: 100% of actions matching deny policies are blocked.
- Human-confirm override: 100% of override decisions are logged with principal, timestamp, and rationale.
- Multi-platform adapters: macOS (AppleScript + Accessibility API), Windows (COM + UI Automation), Linux (xdotool + AT-SPI).
- Unified action model with discriminated union covering click, type, keypress, scroll, drag, screenshot, read_element, launch_app, close_app, clipboard, file_operation.
- Action recording with parameterization and cursor-based replay.
- Desktop policy pack: allowlisted apps, blocked actions, risk-rated operations.
- Integration with Rules Engine for policy evaluation and Observability for action audit.
- SQLite persistence for recordings, policies, permissions, and audit log.
- p95 action dispatch latency < 100 ms (excluding OS execution time).
- All API endpoints use cursor-based pagination (including recording steps via `GET /recordings/:id/steps`) and idempotency keys on all write operations (including deletes).

### Non-Goals (Out of Scope)

- Computer vision / OCR-based element detection (future phase; v1 uses accessibility APIs only).
- Remote desktop control (VNC/RDP) — v1 is local-only.
- Mobile device automation (iOS/Android) — separate workstream.
- GUI test framework integration (Selenium, Appium) — desktop adapters are native.
- Real-time screen streaming — screenshots are point-in-time captures.
- Multi-user concurrent control of the same desktop session.

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Friday Hub                                    │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐                  │
│  │ Agent Runtime │  │ Workflow RT  │  │   API Layer   │                  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘                  │
│         │                 │                   │                          │
│         └─────────────────┴───────────────────┘                          │
│                           │                                              │
│              ┌────────────▼────────────┐                                 │
│              │ Desktop Control Runtime │                                 │
│              │                         │                                 │
│              │  ┌───────────────────┐  │                                 │
│              │  │  Action Executor  │  │                                 │
│              │  │  (dispatch loop)  │  │                                 │
│              │  └────────┬──────────┘  │                                 │
│              │           │             │                                 │
│              │  ┌────────▼──────────┐  │                                 │
│              │  │  Policy Evaluator │──┼──► Rules Engine                 │
│              │  └────────┬──────────┘  │                                 │
│              │           │             │                                 │
│              │  ┌────────▼──────────┐  │                                 │
│              │  │ Permission Manager│  │                                 │
│              │  │ (OS + Friday)     │  │                                 │
│              │  └────────┬──────────┘  │                                 │
│              │           │             │                                 │
│              │  ┌────────▼──────────┐  │                                 │
│              │  │ Platform Adapter  │  │                                 │
│              │  │ ┌─────┐┌────┐┌──┐│  │                                 │
│              │  │ │macOS││ Win││Lx ││  │                                 │
│              │  │ └─────┘└────┘└──┘│  │                                 │
│              │  └───────────────────┘  │                                 │
│              │                         │                                 │
│              │  ┌───────────────────┐  │                                 │
│              │  │ Action Recorder   │  │                                 │
│              │  └───────────────────┘  │                                 │
│              │                         │                                 │
│              │  ┌───────────────────┐  │                                 │
│              │  │ SQLite Persistence│  │                                 │
│              │  └───────────────────┘  │                                 │
│              └─────────────────────────┘                                 │
│                           │                                              │
│              ┌────────────▼────────────┐                                 │
│              │  Observability Layer    │                                 │
│              │  (trace + audit)        │                                 │
│              └─────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Responsibility |
|---|---|
| **Desktop Control Runtime** | Top-level facade; created at hub bootstrap, injected into agent/workflow runtimes |
| **Action Executor** | Validates, policy-checks, and dispatches actions to the platform adapter; manages timeouts and retries |
| **Policy Evaluator** | Evaluates desktop actions against loaded policy rules; delegates to Rules Engine for complex policies |
| **Permission Manager** | Checks OS-level permissions (Accessibility, Screen Recording) and Friday-layer permission grants; prompts for human confirmation on high-risk actions |
| **Platform Adapter** | Abstract interface with macOS, Windows, and Linux implementations; each adapter maps the unified action model to native APIs |
| **Action Recorder** | Captures desktop actions as parameterized recording steps; manages recording lifecycle (idle → recording → paused → stopped) |
| **SQLite Persistence** | Stores recordings, policy rules, permission decisions, and audit entries |

## 5. Multi-Platform Adapter Architecture

### 5.1 Adapter Interface

The adapter contract is split into two complementary types:

- **`FridayDesktopAdapter`** — serialisable metadata DTO describing an
  adapter's identity, platform, capabilities, and health. Used in API
  responses (via `FridayDesktopAdapterDto`) and persistence.
- **`FridayDesktopAdapterRuntime`** — runtime interface that platform
  adapter implementations must satisfy. It exposes a `metadata` accessor
  returning `FridayDesktopAdapter` plus the following runtime methods:

```
metadata: FridayDesktopAdapter                    // serialisable DTO
execute(action): Promise<FridayDesktopActionResult>
inspectElement(selector): Promise<FridayDesktopElement | null>
searchElements(query, appBundleId?): Promise<FridayDesktopElement[]>
getCapabilities(): FridayDesktopCapability[]
checkPermissions(): Promise<FridayDesktopPermission[]>
```

### 5.2 macOS Adapter

- **Primary API:** Accessibility API (AXUIElement) via native bindings.
- **Secondary API:** AppleScript / JXA for app-level scripting (launch, activate, menu commands).
- **Permissions required:** Accessibility (System Preferences → Privacy → Accessibility), Screen Recording (for screenshots).
- **Element tree:** AXUIElement hierarchy with role, title, value, position, size attributes.
- **Key bindings:** CGEvent for low-level key/mouse simulation.

### 5.3 Windows Adapter

- **Primary API:** UI Automation (UIA) via COM interop.
- **Secondary API:** COM Automation for Office and other COM-enabled apps.
- **Permissions required:** UAC elevation for certain system-level actions; no blanket permission prompt equivalent to macOS Accessibility.
- **Element tree:** UIA AutomationElement with ControlType, Name, AutomationId, BoundingRectangle.
- **Key bindings:** SendInput Win32 API.

### 5.4 Linux Adapter

- **Primary API:** AT-SPI (Assistive Technology Service Provider Interface) via D-Bus.
- **Secondary API:** xdotool for X11 key/mouse simulation; libei/ydotool for Wayland.
- **Permissions required:** D-Bus session bus access; X11 requires no special permissions; Wayland requires portal authorization.
- **Element tree:** AT-SPI Accessible objects with role, name, description, component interface.
- **Key bindings:** XTest extension (X11) or libei (Wayland).

### 5.5 Adapter Selection

The runtime detects the current platform via `process.platform` and instantiates the appropriate adapter. If the platform is unsupported, a `NullAdapter` is used that returns `unsupported_platform` errors for all operations.

## 6. Permission Model

### 6.1 Three-Layer Permission Stack

```
┌─────────────────────────────┐
│ Layer 3: Human Confirmation │  ← High-risk actions require explicit approval
├─────────────────────────────┤
│ Layer 2: Friday Policy      │  ← Policy rules (allow/deny/warn/audit)
├─────────────────────────────┤
│ Layer 1: OS Permissions     │  ← Accessibility, Screen Recording, etc.
└─────────────────────────────┘
```

1. **OS Permissions:** The adapter checks whether required OS-level permissions are granted (e.g., macOS Accessibility). If not, execution fails with `permission_denied_os` and the runtime can surface a permission prompt to guide the user.

2. **Friday Policy:** The action is evaluated against loaded desktop policy rules. Each rule specifies an action type, optional app filter, risk level, and decision (allow/deny/warn/audit). Deny rules block execution immediately.

3. **Human Confirmation:** Actions classified as `critical` risk level require explicit human approval before execution. The runtime emits a `FridayDesktopPermissionPrompt` and waits for a `FridayDesktopPermissionDecision`. All decisions are logged.

### 6.2 Permission Prompt Flow

```
Agent requests action
  → Policy Evaluator classifies risk as "critical"
    → Permission Manager emits FridayDesktopPermissionPrompt
      → UI renders prompt to user
        → User approves/denies with optional rationale
          → Permission Manager records FridayDesktopPermissionDecision
            → If approved: action proceeds
            → If denied: action blocked with "permission_denied_user"
```

### 6.3 Permission Caching

- **OS permissions:** Checked once at adapter initialization and cached; re-checked on `permission_denied_os` errors.
- **Policy decisions:** Evaluated per-action (stateless; policy may change between actions).
- **Human decisions:** Optionally cached per (action_type, app, principal) with configurable TTL (default: session-scoped, no persistence across restarts).

## 7. Sandbox Boundaries

### 7.1 File System Access

- Desktop file operations (`read`, `write`, `move`, `copy`, `delete`, `list`, `stat`) each map to a corresponding adapter capability (`file_read`, `file_write`, `file_move`, `file_copy`, `file_delete`, `file_list`, `file_stat`). Adapters declare which file capabilities they support during capability negotiation.
- Desktop actions can read/write files only within policy-allowlisted directories.
- Default allowlist: user home directory, Desktop, Documents, Downloads.
- System directories (`/System`, `C:\Windows`, `/etc`) are deny-listed by default.
- File operations are logged to the audit trail with full path and operation type.

### 7.2 Network

- Desktop actions do not directly access the network.
- If an automated app makes network requests, those are outside DSK's control boundary.
- Clipboard operations that transfer data to/from network-accessible apps are logged.

### 7.3 Process Control

- `launch_app` and `close_app` actions are restricted to policy-allowlisted applications.
- Process kill/force-quit is classified as `high` risk by default.
- Spawning arbitrary processes via desktop automation is blocked; only named app launch is supported.

### 7.4 Clipboard

- Clipboard read is classified as `medium` risk (may contain sensitive data).
- Clipboard write is classified as `low` risk.
- All clipboard operations are logged with a content hash (not content itself) for audit.

## 8. Action Recording and Replay

### 8.1 Recording Lifecycle

```
idle → recording → paused → recording → stopped
                                          │
                                          ▼
                                      persisted
```

- **Start:** Agent or user initiates recording; a `FridayDesktopRecording` is created with state `recording`.
- **Capture:** Each action executed through the runtime is captured as a `FridayDesktopRecordingStep` with timestamp, action, result, and optional parameter bindings.
- **Pause/Resume:** Recording can be paused (e.g., during sensitive operations) and resumed.
- **Stop:** Recording transitions to `stopped`; steps are persisted to SQLite.

### 8.2 Parameterization

Recording steps can have parameter bindings that replace concrete values with named parameters:

```
Step: type "john@example.com" into element "Email Field"
Parameterized: type {{email}} into element "Email Field"
```

Parameters are stored as a map of `name → { type, defaultValue, description, required }` on the recording
(see `FridayDesktopRecordingParameterMap`). Valid recording state transitions are enforced by the
`FRIDAY_DESKTOP_RECORDING_STATE_TRANSITIONS` constant: `idle → recording ↔ paused → stopped`.

### 8.3 Replay

- Replay instantiates a recording with parameter values and executes each step sequentially.
- Each replayed action passes through the full policy/permission pipeline (no bypass).
- Replay can be paused, stepped through, or cancelled.
- Replay results are captured as a new action result set linked to the recording.

## 9. Desktop Policy Pack

### 9.1 Policy Structure

A desktop policy is a named collection of rules:

```yaml
id: default-desktop-policy
name: Default Desktop Safety Policy
rules:
  - action: file_operation
    appFilter: "*"
    riskLevel: high
    decision: warn
    description: "File operations require warning"
    
  - action: close_app
    appFilter: "com.apple.finder"
    riskLevel: critical
    decision: deny
    description: "Never close Finder automatically"
    
  - action: click
    appFilter: "*"
    riskLevel: low
    decision: allow
    description: "Clicks are generally safe"
```

### 9.2 Rule Matching

Rules are matched by:
1. **Action type** — exact match on the discriminated union tag.
2. **App filter** — glob match on app bundle ID / executable name (`*` matches all).
3. **Element filter** — optional glob match on element role or identifier.
4. **Priority** — higher priority rules take precedence; first match wins.

### 9.3 Risk Levels

| Level | Description | Default Behavior |
|---|---|---|
| `none` | No risk (read-only, informational) | Allow silently |
| `low` | Low risk (clicks, scrolls) | Allow, audit |
| `medium` | Medium risk (typing, clipboard read) | Allow, audit, warn in logs |
| `high` | High risk (file operations, app close, process control) | Warn user, require acknowledgment |
| `critical` | Critical risk (system-level changes, credential fields) | Block unless human confirms |

### 9.4 Built-in Policy Pack

The runtime ships with a default policy pack that classifies all action types by risk level. Users can override or extend with custom policies. Custom policies are merged with built-in policies; explicit user rules take precedence.

## 10. Integration with Rules Engine

- Desktop policy rules are a specialized subset of Friday Rules Engine policies.
- The Policy Evaluator delegates to the Rules Engine when a desktop action matches a rule with `engineDelegate: true`.
- This allows complex cross-domain policies (e.g., "deny file_operation if the current workflow has already exceeded its file write budget").
- Evaluation results from the Rules Engine are mapped to desktop-specific decisions.

### Rules Engine Context

Desktop actions are evaluated through the Rules Engine using the typed
`FridayDesktopRuleEvaluationContext` bridge type. The `resource` is always
`"desktop"` and the `action` is one of the `FridayDesktopRuleAction` values
(matching `FridayDesktopActionType`):

```typescript
const ctx: FridayDesktopRuleEvaluationContext = {
  resource: "desktop",
  action: "file_operation",
  args: {
    platform: "darwin",
    appBundleId: "com.apple.textedit",
    filePath: "/Users/user/Documents/report.txt",
    operationType: "write",
    riskLevel: "high",
  },
  source: "agent",
};
```

The desktop action types are registered in `FridayRuleAction` so no type
casts are needed when constructing evaluation contexts.

## 11. Integration with Observability

- Every action execution emits a trace span with:
  - `traceId`, `spanId`, `parentSpanId` (from the calling agent/workflow trace)
  - Action type, target element, app, platform
  - Duration, result status, error (if any)
- Permission prompts and decisions emit audit entries with tamper-evident hashing.
- Policy evaluations emit audit entries with the matched rule, decision, and rationale.
- Recordings emit lifecycle events (start, pause, resume, stop, replay).

## 12. Edge Cases

### 12.1 Permission Denied by OS

- Adapter detects OS permission denial (e.g., macOS Accessibility not granted).
- Returns `permission_denied_os` with a structured prompt guiding the user to System Settings.
- Runtime caches the denial and does not retry until the user signals re-check.

### 12.2 App Not Responding

- Adapter sets a per-action timeout (default: 10 seconds for UI actions, 30 seconds for launch_app).
- If the target app is unresponsive (e.g., spinning beach ball), the action times out.
- Returns `timeout` status with the hung app's info.
- Recorder pauses if a step times out during recording.

### 12.3 Screen Resolution Changes

- Element coordinates are stored as (x, y, width, height) at capture time plus the screen resolution.
- On replay, if resolution differs, coordinates are scaled proportionally or the element is re-located by selector.
- If neither scaling nor re-location succeeds, the step fails with `element_not_found`.

### 12.4 Multi-Monitor

- Element selectors include a `displayIndex` field (0-based).
- The adapter maps display indices to physical screens via OS APIs.
- If the target display is not present at replay time, the step fails with `display_not_found`.

### 12.5 Headless Execution

- Some adapters (Linux xdotool) support headless execution via virtual framebuffer (Xvfb).
- macOS and Windows adapters require an active GUI session.
- The capability `headless` is reported by adapters that support it.
- If headless execution is requested on an adapter that doesn't support it, returns `unsupported_capability`.

### 12.6 Accessibility API Changes Between OS Versions

- Adapters declare a `supportedOsVersions` range.
- At initialization, the adapter checks the OS version and warns if outside supported range.
- API changes are handled by versioned adapter implementations (e.g., `MacOSAdapter_14`, `MacOSAdapter_15`).
- Capability discovery reflects the actual API surface available on the running OS version.

## 13. Non-Functional Requirements

| NFR | Target | Measurement |
|---|---|---|
| Action success rate | > 95% | Per-platform golden suite (50+ actions across 10 apps) |
| Unsafe action block rate | 100% | Policy rule deny tests (zero false negatives) |
| Human-confirm override logging | 100% | Audit log completeness check |
| Action dispatch latency (p95) | < 100 ms | Measured from runtime entry to adapter call (excludes OS execution) |
| Recording replay fidelity | > 90% | Replayed recordings match expected outcomes |
| Policy evaluation latency (p95) | < 10 ms | In-memory rule matching benchmark |
| Permission prompt response timeout | 5 minutes | Configurable; action cancelled on timeout |
| SQLite write throughput | > 1000 ops/sec | Audit log + recording step persistence |
| Adapter initialization time | < 2 seconds | Cold start to ready state |

## 14. Architecture Decision Records

### ADR-DSK-001: Accessibility APIs over Computer Vision

**Context:** Desktop element interaction can use accessibility APIs (structured element trees) or computer vision (screenshot + OCR + coordinate inference).

**Decision:** Use accessibility APIs as the primary mechanism for element interaction.

**Rationale:**
- Accessibility APIs provide structured, semantic element data (role, name, value, bounds).
- No dependency on screen rendering or resolution.
- Faster and more reliable than CV-based approaches.
- CV can be added as a fallback in a future phase.

**Consequences:** Limited to apps that expose accessibility trees. Some custom-rendered UIs (games, certain Electron apps) may have sparse accessibility data.

### ADR-DSK-002: Platform-Specific Native Bindings over Universal Protocol

**Context:** A universal protocol (e.g., WebDriver-like) could abstract all platforms, but each platform's accessibility API has unique capabilities.

**Decision:** Implement platform-specific adapters with native bindings behind a shared interface.

**Rationale:**
- Maximizes capability coverage per platform.
- Avoids lowest-common-denominator API surface.
- Capability discovery lets callers adapt to platform differences.
- The shared `FridayDesktopAdapter` interface ensures consistent caller experience.

**Consequences:** Three adapter implementations to maintain. New platform support requires a new adapter.

### ADR-DSK-003: SQLite for Recording and Policy Persistence

**Context:** Recordings and policies need persistent storage. Options: SQLite, filesystem JSON, PostgreSQL.

**Decision:** Use SQLite, consistent with all other Friday persistence.

**Rationale:**
- Single-file database, no external dependencies.
- ACID transactions for recording step writes.
- Consistent with Rules Engine, Packaging, Observability persistence patterns.
- FTS5 for element search indexing.

**Consequences:** Not suitable for multi-instance concurrent writes (acceptable for local desktop runtime).

### ADR-DSK-004: Three-Layer Permission Model

**Context:** Desktop automation carries inherent risk. A single permission layer is insufficient.

**Decision:** Implement three layers: OS permissions → Friday policy → human confirmation.

**Rationale:**
- OS permissions are non-negotiable (can't bypass macOS Accessibility gate).
- Friday policy provides configurable, auditable safety rules.
- Human confirmation adds a final gate for critical actions.
- Layered defense reduces the chance of unintended actions.

**Consequences:** Higher latency for critical actions (human-in-the-loop). Acceptable tradeoff for safety.

### ADR-DSK-005: Action Recording as First-Class Feature

**Context:** Recording could be a separate module or integrated into the runtime.

**Decision:** Integrate recording into the Desktop Control Runtime as a first-class feature.

**Rationale:**
- Recording needs access to action execution internals (pre/post hooks).
- Parameterization requires understanding action structure.
- Replay must pass through the same policy/permission pipeline.
- Tight integration avoids data serialization overhead.

**Consequences:** Recording adds complexity to the runtime. Mitigated by clean separation via `FridayDesktopRecording` and `FridayDesktopRecordingStep` types.

## 15. Persistence Schema (SQLite)

### 15.1 Tables

```sql
-- Desktop recordings
CREATE TABLE desktop_recordings (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  state           TEXT NOT NULL DEFAULT 'idle',  -- idle|recording|paused|stopped
  platform        TEXT NOT NULL,                  -- darwin|win32|linux
  parameters_json TEXT NOT NULL DEFAULT '{}',
  tags_json       TEXT NOT NULL DEFAULT '[]',
  created_by      TEXT NOT NULL,
  tenant_id       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  stopped_at      TEXT
);

-- Recording steps
CREATE TABLE desktop_recording_steps (
  id              TEXT PRIMARY KEY,
  recording_id    TEXT NOT NULL REFERENCES desktop_recordings(id),
  step_index      INTEGER NOT NULL,
  action_json     TEXT NOT NULL,
  result_json     TEXT,
  element_json    TEXT,
  parameter_bindings_json TEXT NOT NULL DEFAULT '{}',
  timestamp       TEXT NOT NULL,
  duration_ms     INTEGER,
  UNIQUE(recording_id, step_index)
);

-- Desktop policies
CREATE TABLE desktop_policies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 0,
  tenant_id       TEXT,
  created_by      TEXT NOT NULL,
  etag            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Desktop policy rules
CREATE TABLE desktop_policy_rules (
  id              TEXT PRIMARY KEY,
  policy_id       TEXT NOT NULL REFERENCES desktop_policies(id),
  action_type     TEXT NOT NULL,
  app_filter      TEXT NOT NULL DEFAULT '*',
  element_filter  TEXT,
  risk_level      TEXT NOT NULL,
  decision        TEXT NOT NULL,       -- allow|deny|warn|audit
  engine_delegate INTEGER NOT NULL DEFAULT 0,
  description     TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

-- Permission decisions (audit trail)
CREATE TABLE desktop_permission_decisions (
  id              TEXT PRIMARY KEY,
  action_type     TEXT NOT NULL,
  app_bundle_id   TEXT,
  element_desc    TEXT,
  risk_level      TEXT NOT NULL,
  decision        TEXT NOT NULL,       -- approved|denied|timeout
  decided_by      TEXT NOT NULL,
  rationale       TEXT,
  prompt_id       TEXT NOT NULL,
  tenant_id       TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT
);

-- Action audit log
CREATE TABLE desktop_action_log (
  id              TEXT PRIMARY KEY,
  action_type     TEXT NOT NULL,
  action_json     TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  status          TEXT NOT NULL,
  platform        TEXT NOT NULL,
  app_bundle_id   TEXT,
  element_json    TEXT,
  policy_rule_id  TEXT,
  permission_id   TEXT,
  trace_id        TEXT,
  span_id         TEXT,
  principal_id    TEXT,
  tenant_id       TEXT,
  duration_ms     INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_action_log_trace ON desktop_action_log(trace_id);
CREATE INDEX idx_action_log_created ON desktop_action_log(created_at);
CREATE INDEX idx_action_log_type ON desktop_action_log(action_type);
CREATE INDEX idx_recording_steps_rec ON desktop_recording_steps(recording_id);
CREATE INDEX idx_policy_rules_policy ON desktop_policy_rules(policy_id);
CREATE INDEX idx_permission_decisions_prompt ON desktop_permission_decisions(prompt_id);
```

### 15.2 Row Types

Row types map 1:1 to SQLite table columns using snake_case naming. JSON columns store serialized domain objects. See `FridayDesktopRecordingRow`, `FridayDesktopRecordingStepRow`, `FridayDesktopPolicyRow`, `FridayDesktopPolicyRuleRow`, `FridayDesktopPermissionDecisionRow`, `FridayDesktopActionLogRow` in the domain model types.

## 16. API Endpoint Matrix

Every endpoint declared in `friday-desktop-api.types.ts` is listed below.
Write endpoints require an idempotency key unless noted otherwise.

| Method | Path | operationId | Request Type | Response Type |
|--------|------|-------------|--------------|---------------|
| `POST` | `/api/desktop/actions/execute` | `executeDesktopAction` | `FridayExecuteDesktopActionRequest` | `FridayExecuteDesktopActionResponse` |
| `POST` | `/api/desktop/actions/batch` | `batchDesktopActions` | `FridayBatchDesktopActionsRequest` | `FridayBatchDesktopActionsResponse` |
| `POST` | `/api/desktop/actions/:actionId/cancel` | `cancelDesktopAction` | `FridayCancelDesktopActionRequest` | `FridayCancelDesktopActionResponse` |
| `GET` | `/api/desktop/actions/log` | `listDesktopActionLog` | `FridayListDesktopActionLogQuery` | `FridayListDesktopActionLogResponse` |
| `POST` | `/api/desktop/recordings` | `startDesktopRecording` | `FridayStartDesktopRecordingRequest` | `FridayStartDesktopRecordingResponse` |
| `GET` | `/api/desktop/recordings` | `listDesktopRecordings` | `FridayListDesktopRecordingsQuery` | `FridayListDesktopRecordingsResponse` |
| `GET` | `/api/desktop/recordings/:recordingId` | `getDesktopRecording` | — | `FridayGetDesktopRecordingResponse` |
| `GET` | `/api/desktop/recordings/:recordingId/steps` | `listDesktopRecordingSteps` | `FridayListDesktopRecordingStepsQuery` | `FridayListDesktopRecordingStepsResponse` |
| `POST` | `/api/desktop/recordings/:recordingId/stop` | `stopDesktopRecording` | `FridayStopDesktopRecordingRequest` | `FridayStopDesktopRecordingResponse` |
| `POST` | `/api/desktop/recordings/:recordingId/pause` | `pauseDesktopRecording` | `FridayPauseDesktopRecordingRequest` | `FridayPauseDesktopRecordingResponse` |
| `POST` | `/api/desktop/recordings/:recordingId/resume` | `resumeDesktopRecording` | `FridayResumeDesktopRecordingRequest` | `FridayResumeDesktopRecordingResponse` |
| `POST` | `/api/desktop/recordings/:recordingId/replay` | `replayDesktopRecording` | `FridayReplayDesktopRecordingRequest` | `FridayReplayDesktopRecordingResponse` |
| `DELETE` | `/api/desktop/recordings/:recordingId` | `deleteDesktopRecording` | `FridayDeleteDesktopRecordingRequest` | `FridayDeleteDesktopRecordingResponse` |
| `POST` | `/api/desktop/policies` | `createDesktopPolicy` | `FridayCreateDesktopPolicyRequest` | `FridayCreateDesktopPolicyResponse` |
| `GET` | `/api/desktop/policies` | `listDesktopPolicies` | `FridayListDesktopPoliciesQuery` | `FridayListDesktopPoliciesResponse` |
| `GET` | `/api/desktop/policies/:policyId` | `getDesktopPolicy` | — | `FridayGetDesktopPolicyResponse` |
| `PATCH` | `/api/desktop/policies/:policyId` | `updateDesktopPolicy` | `FridayUpdateDesktopPolicyRequest` | `FridayUpdateDesktopPolicyResponse` |
| `DELETE` | `/api/desktop/policies/:policyId` | `deleteDesktopPolicy` | `FridayDeleteDesktopPolicyRequest` | `FridayDeleteDesktopPolicyResponse` |
| `POST` | `/api/desktop/policies/:policyId/rules` | `addDesktopPolicyRule` | `FridayAddDesktopPolicyRuleRequest` | `FridayAddDesktopPolicyRuleResponse` |
| `DELETE` | `/api/desktop/policies/:policyId/rules/:ruleId` | `removeDesktopPolicyRule` | `FridayRemoveDesktopPolicyRuleRequest` | `FridayRemoveDesktopPolicyRuleResponse` |
| `GET` | `/api/desktop/permissions` | `listDesktopPermissions` | — | `FridayListDesktopPermissionsResponse` ¹ |
| `POST` | `/api/desktop/permissions/prompts/:promptId/respond` | `respondToDesktopPermissionPrompt` | `FridayRespondToPermissionPromptRequest` | `FridayRespondToPermissionPromptResponse` |
| `GET` | `/api/desktop/permissions/decisions` | `listDesktopPermissionDecisions` | `FridayListDesktopPermissionDecisionsQuery` | `FridayListDesktopPermissionDecisionsResponse` |
| `GET` | `/api/desktop/platform` | `getDesktopPlatform` | — | `FridayGetDesktopPlatformResponse` |
| `POST` | `/api/desktop/elements/inspect` | `inspectDesktopElement` | `FridayInspectDesktopElementRequest` | `FridayInspectDesktopElementResponse` |
| `GET` | `/api/desktop/elements/search` | `searchDesktopElements` | `FridaySearchDesktopElementsQuery` | `FridaySearchDesktopElementsResponse` |

¹ Not paginated — the OS permission set is small and fixed (see `FridayDesktopOsPermissionType`).

## 17. Future Work

- **Computer Vision Fallback:** Add screenshot + OCR-based element detection for apps with sparse accessibility trees.
- **Remote Desktop:** Extend adapters to support VNC/RDP for remote machine control.
- **Recording Marketplace:** Share and discover recordings across tenants.
- **Natural Language Action Authoring:** "Click the submit button in the top-right" → structured action.
- **Conditional Recording Steps:** If/else and loop constructs in recordings.
- **Multi-Instance Coordination:** Coordinate desktop actions across multiple machines.
