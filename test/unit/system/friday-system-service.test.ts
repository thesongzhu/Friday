import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";
import { createFridaySystemService } from "../../../src/system/engine/friday-system-service.js";
import {
  createFridayMutatingActionDigest,
  createFridaySystemIntentMutatingActionRequest,
  signFridayCanonicalApproval,
} from "../../../src/security/friday-mutating-action-gate.js";
import { createFridaySystemUnavailableCompanionBridge } from "../../../src/system/companion/friday-system-local-companion-bridge.js";
import type { FridaySystemCompanionBridge } from "../../../src/system/companion/friday-system-companion.types.js";
import type { FridaySystemRemoteAuthAdapter } from "../../../src/system/auth/friday-system-remote-auth.js";
import type { FridaySystemExecResult } from "../../../src/system/engine/friday-system-service.js";
import type { FridaySystemIntentInput } from "../../../src/system/model/friday-system.types.js";
import type { FridaySqliteLayer } from "#state";

const WORKSPACE_ROOT = "/tmp/friday-system-test-workspace";
let fixtureSequence = 0;

function createNowIso() {
  let tick = 0;
  const start = Date.parse("2026-03-06T12:00:00.000Z");
  return () => new Date(start + tick++ * 1000).toISOString();
}

interface CompanionTestState {
  safeMode: boolean;
  overlayVisible: boolean;
}

function createCompanionCapabilities(notificationIntake = true) {
  return {
    surfaces: {
      launchAtLogin: true,
      menuBar: true,
      overlay: true,
      globalHotkey: true,
      windowInventory: true,
      notificationIntake,
      screenCapture: true,
    },
    actions: {
      snapshot: "supported" as const,
      launch_app: "supported" as const,
      focus: "supported" as const,
      open_url: "supported" as const,
      open_project: "supported" as const,
      handoff_to_browser: "supported" as const,
      handoff_to_terminal: "supported" as const,
      arrange_windows: "supported" as const,
      notification_list: notificationIntake ? "supported" as const : "unsupported" as const,
      read_notification: notificationIntake ? "supported" as const : "unsupported" as const,
      notification_act: notificationIntake ? "supported" as const : "unsupported" as const,
      recover_ui: "supported" as const,
    },
  };
}

function createCompanionBridge(state: CompanionTestState = {
  safeMode: false,
  overlayVisible: true,
}): FridaySystemCompanionBridge {
  let connected = false;
  const notifications = [
    {
      id: "notif-1",
      sourceApp: "Finder",
      title: "Build finished",
      receivedAt: "2026-03-06T12:00:00.000Z",
      read: false,
    },
  ];
  return {
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
    async ping() {
      return {
        ok: true as const,
        serverTime: "2026-03-06T12:00:00.000Z",
      };
    },
    async getStatus() {
      return {
        id: "companion-1",
        platform: "darwin" as const,
        connected,
        transport: {
          mode: "in_process" as const,
          protocol: "jsonrpc-2.0" as const,
          authenticated: true,
          socketPath: `${WORKSPACE_ROOT}/companion.sock`,
        },
        launchAtLoginEnabled: true,
        panicHotkey: "cmd+shift+escape",
        safeMode: state.safeMode,
        overlayVisible: state.overlayVisible,
        lastHeartbeatAt: "2026-03-06T12:00:00.000Z",
        capabilities: createCompanionCapabilities(true),
        permissions: [],
      };
    },
    async captureSnapshot() {
      return {
        apps: [
          {
            id: "app:finder",
            name: "Finder",
            bundleId: "com.apple.finder",
            running: true,
            frontmost: true,
          },
        ],
        windows: [
          {
            id: "window:finder:1",
            appId: "app:finder",
            title: "Workspace",
            focused: true,
          },
        ],
        notifications,
        frontmostAppId: "app:finder",
        frontmostWindowId: "window:finder:1",
      };
    },
    async arrangeWindows() {
      return {
        arrangedWindowIds: ["window:finder:1"],
        layout: "single_focus" as const,
        arrangedAt: "2026-03-06T12:00:00.000Z",
      };
    },
    async launchApp(appIdentifier) {
      return {
        appIdentifier,
        launchedAt: "2026-03-06T12:00:00.000Z",
      };
    },
    async focusTarget(input) {
      return {
        appIdentifier: input.appIdentifier,
        windowId: input.windowId,
        focused: true,
        focusedAt: "2026-03-06T12:00:00.000Z",
      };
    },
    async openUrl(url) {
      return {
        url,
        openedAt: "2026-03-06T12:00:00.000Z",
      };
    },
    async openProject(projectPath) {
      return {
        projectPath,
        openedAt: "2026-03-06T12:00:00.000Z",
      };
    },
    async listNotifications() {
      return notifications;
    },
    async actOnNotification(input) {
      const notification = notifications.find((item) => item.id === input.notificationId);
      if (!notification) {
        return null;
      }
      notification.read = true;
      return {
        notification,
        action: input.action,
        actedAt: "2026-03-06T12:00:00.000Z",
      };
    },
    async setOverlayVisible(visible) {
      state.safeMode = false;
      state.overlayVisible = visible;
      return {
        visible: state.overlayVisible,
        changedAt: "2026-03-06T12:00:00.000Z",
      };
    },
  };
}

function createRemoteAuthAdapter(): FridaySystemRemoteAuthAdapter {
  return {
    async generateRegistrationOptions(input) {
      return {
        challenge: `register-challenge:${input.userId}`,
        rp: {
          name: input.rpName,
          id: input.rpId,
        },
        user: {
          id: input.userId,
          name: input.userName,
          displayName: input.userDisplayName,
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        timeout: 300000,
      };
    },
    async verifyRegistration(input) {
      const responseId = input.response.id;
      if (!responseId || responseId === "bad-registration") {
        return { verified: false };
      }
      return {
        verified: true,
        credentialId: responseId,
        publicKey: "public-key-b64u",
        counter: 1,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        origin: input.expectedOrigin,
        rpId: input.expectedRpId,
      };
    },
    async generateAuthenticationOptions(input) {
      return {
        challenge: `assert-challenge:${input.credentialId}`,
        rpId: input.rpId,
        allowCredentials: [{
          id: input.credentialId,
          type: "public-key",
          transports: input.transports,
        }],
        timeout: 300000,
      };
    },
    async verifyAuthentication(input) {
      const responseId = input.response.id;
      if (!responseId || responseId === "bad-assertion" || responseId !== input.passkey.credentialId) {
        return { verified: false };
      }
      return {
        verified: true,
        credentialId: responseId,
        newCounter: input.passkey.counter + 1,
        transports: input.passkey.transports,
        deviceType: input.passkey.deviceType,
        backedUp: input.passkey.backedUp,
        origin: input.expectedOrigin,
        rpId: input.expectedRpId,
      };
    },
  };
}

async function createServiceFixture() {
  return createServiceFixtureWithOptions();
}

async function createServiceFixtureWithOptions(options?: {
  db?: FridaySqliteLayer;
  execCommand?: (command: string, args: string[]) => Promise<FridaySystemExecResult>;
  remoteMode?: "trusted_private_network" | "disabled";
  remoteAuthAdapter?: FridaySystemRemoteAuthAdapter;
  companionBridge?: FridaySystemCompanionBridge;
  companionState?: CompanionTestState;
  companionReconnectIntervalMs?: number;
  warn?: (message: string) => void;
  canonicalMutationGate?: boolean;
  canonicalApprovalSecret?: string;
}) {
  const db = options?.db ?? createTestDb();
  const fixtureId = ++fixtureSequence;
  const nextId = createTestIdGenerator();
  const idGenerator = () => `fixture-${fixtureId}-${nextId()}`;
  const nowIso = createNowIso();
  const execCommand = vi.fn(options?.execCommand ?? (async (command: string) => {
    if (command === "pbpaste") {
      return { exitCode: 0, stdout: "clipboard text", stderr: "" };
    }
    if (command === "rg") {
      return { exitCode: 0, stdout: "src/app.ts\nREADME.md\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }));
  const service = await createFridaySystemService({
    db,
    idGenerator,
    nowIso,
    workspaceRoot: WORKSPACE_ROOT,
    companionBridge: options?.companionBridge ?? createCompanionBridge(options?.companionState),
    execCommand,
    remoteMode: options?.remoteMode,
    canonicalMutationGate: options?.canonicalMutationGate,
    canonicalApprovalSecret: options?.canonicalApprovalSecret,
    remoteAuthAdapter: options?.remoteAuthAdapter ?? createRemoteAuthAdapter(),
    companionReconnectIntervalMs: options?.companionReconnectIntervalMs,
    warn: options?.warn,
    remoteAuth: {
      rpName: "Friday Agent OS",
      rpId: "localhost",
      origin: "http://localhost:3141",
    },
  });
  return {
    db,
    service,
    execCommand,
  };
}

describe("createFridaySystemService", () => {
  const allocatedDbs: FridaySqliteLayer[] = [];

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
  });

  it("returns session and state snapshots with persisted startup event", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    const session = await fixture.service.getSession();
    const state = await fixture.service.getState();
    const events = fixture.service.listEvents();

    expect(session.mode).toBe("agent_os");
    expect(session.remoteMode).toBe("disabled");
    expect(state.apps[0]?.name).toBe("Finder");
    expect(state.health.status).toBe("degraded");
    expect(events.map((event) => event.event)).toContain("system.session.started");
    expect(events.map((event) => event.event)).toContain("system.health.updated");
    expect(events.map((event) => event.event)).toContain("system.companion.connected");
  });

  it("seeds default prompt approval rules for command-center risk gates", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    const approvals = fixture.service.listApprovalRules();
    const defaults = approvals.filter((approval) =>
      ["clipboard_read", "close_app", "notification_act"].includes(approval.action),
    );
    const state = await fixture.service.getState();

    expect(defaults).toHaveLength(3);
    expect(defaults.map((approval) => approval.decision)).toEqual(["prompt", "prompt", "prompt"]);
    expect(defaults.map((approval) => approval.riskLevel)).toEqual(["high", "high", "high"]);
    expect(state.approvalsSummary.total).toBeGreaterThanOrEqual(3);
  });

  it("starts in degraded mode when the companion socket is unavailable", async () => {
    const warn = vi.fn();
    const fixture = await createServiceFixtureWithOptions({
      companionReconnectIntervalMs: 0,
      warn,
      companionBridge: {
        ...createCompanionBridge(),
        async connect() {
          throw new Error("connect ENOENT /tmp/system-companion.sock");
        },
        isConnected() {
          return false;
        },
        async getStatus() {
          return {
            id: "companion-offline",
            platform: "darwin" as const,
            connected: false,
            transport: {
              mode: "unix_socket" as const,
              protocol: "jsonrpc-2.0" as const,
              authenticated: false,
              socketPath: `${WORKSPACE_ROOT}/system-companion.sock`,
            },
            launchAtLoginEnabled: true,
            panicHotkey: "cmd+shift+escape",
            safeMode: false,
            overlayVisible: false,
            lastHeartbeatAt: "2026-03-06T12:00:00.000Z",
            capabilities: createCompanionCapabilities(true),
            permissions: [],
          };
        },
      },
    });
    allocatedDbs.push(fixture.db);

    const session = await fixture.service.getSession();
    const events = fixture.service.listEvents();

    expect(session.health.status).toBe("unavailable");
    expect(session.health.reasons).toContain("companion_disconnected");
    expect(events.map((event) => event.event)).toContain("system.session.started");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("system companion unavailable at startup"),
    );
  });

  it("does not capture a snapshot when the companion is disconnected", async () => {
    const captureSnapshot = vi.fn(async () => {
      throw new Error("capture should be skipped when disconnected");
    });
    const fixture = await createServiceFixtureWithOptions({
      companionReconnectIntervalMs: 0,
      companionBridge: {
        ...createCompanionBridge(),
        async connect() {
          throw new Error("connect ENOENT /tmp/system-companion.sock");
        },
        isConnected() {
          return false;
        },
        async getStatus() {
          return {
            id: "companion-offline",
            platform: "darwin" as const,
            connected: false,
            transport: {
              mode: "unix_socket" as const,
              protocol: "jsonrpc-2.0" as const,
              authenticated: false,
              socketPath: `${WORKSPACE_ROOT}/system-companion.sock`,
            },
            launchAtLoginEnabled: true,
            panicHotkey: "cmd+shift+escape",
            safeMode: false,
            overlayVisible: false,
            lastHeartbeatAt: "2026-03-06T12:00:00.000Z",
            capabilities: createCompanionCapabilities(true),
            permissions: [],
          };
        },
        captureSnapshot,
      },
    });
    allocatedDbs.push(fixture.db);

    const state = await fixture.service.getState();

    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(state.apps).toEqual([]);
    expect(state.windows).toEqual([]);
    expect(state.notifications).toEqual([]);
    expect(state.health.status).toBe("unavailable");
  });

  it("deduplicates degraded companion startup warnings across service instances when only the socket path changes", async () => {
    const warn = vi.fn();
    const firstFixture = await createServiceFixtureWithOptions({
      warn,
      companionReconnectIntervalMs: 0,
      companionBridge: {
        ...createCompanionBridge(),
        async connect() {
          throw new Error("connect ENOENT /tmp/system-companion-a.sock");
        },
        isConnected() {
          return false;
        },
      },
    });
    const secondFixture = await createServiceFixtureWithOptions({
      warn,
      companionReconnectIntervalMs: 0,
      companionBridge: {
        ...createCompanionBridge(),
        async connect() {
          throw new Error("connect ENOENT /tmp/system-companion-b.sock");
        },
        isConnected() {
          return false;
        },
      },
    });
    allocatedDbs.push(firstFixture.db, secondFixture.db);

    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("system companion unavailable at startup; continuing in degraded mode"),
      ),
    ).toHaveLength(1);
  });

  it("propagates native companion safe mode into health and revokes the active lease", async () => {
    const companionState: CompanionTestState = {
      safeMode: false,
      overlayVisible: true,
    };
    const fixture = await createServiceFixtureWithOptions({ companionState });
    allocatedDbs.push(fixture.db);

    const lease = await fixture.service.executeIntent({
      action: "request_control",
      actorId: "operator-1",
      actorKind: "api",
      reason: "operator_control",
    });
    expect(lease.status).toBe("completed");

    companionState.safeMode = true;
    companionState.overlayVisible = false;
    const session = await fixture.service.getSession();
    const state = await fixture.service.getState();
    const events = fixture.service.listEvents();

    expect(session.health.status).toBe("safe_mode");
    expect(state.health.safeMode).toBe(true);
    expect(state.companion.safeMode).toBe(true);
    expect(state.controlLease).toBeNull();
    expect(events.map((event) => event.event)).toContain("system.safe_mode.entered");
    expect(events.map((event) => event.event)).toContain("system.control.released");
  });

  it("uses companion permissions when the desktop session is unavailable", async () => {
    const nextId = createTestIdGenerator();
    const fixtureId = ++fixtureSequence;
    const db = createTestDb();
    allocatedDbs.push(db);
    const service = await createFridaySystemService({
      db,
      idGenerator: () => `fixture-${fixtureId}-${nextId()}`,
      nowIso: createNowIso(),
      workspaceRoot: WORKSPACE_ROOT,
      companionBridge: {
        async connect() {},
        async disconnect() {},
        isConnected() {
          return true;
        },
        async ping() {
          return {
            ok: true as const,
            serverTime: "2026-03-06T12:00:00.000Z",
          };
        },
        async getStatus() {
          return {
            id: "companion-telemetry",
            platform: "darwin" as const,
            connected: true,
            transport: {
              mode: "unix_socket" as const,
              protocol: "jsonrpc-2.0" as const,
              authenticated: true,
              socketPath: `${WORKSPACE_ROOT}/companion.sock`,
            },
            launchAtLoginEnabled: true,
            panicHotkey: "cmd+shift+escape",
            safeMode: false,
            overlayVisible: true,
            lastHeartbeatAt: "2026-03-06T12:00:00.000Z",
            capabilities: createCompanionCapabilities(false),
            permissions: [
              {
                id: "perm-1",
                permission: "screen_recording",
                status: "not_determined",
              },
            ],
          };
        },
        async captureSnapshot() {
          return {
            apps: [],
            windows: [],
            notifications: [],
          };
        },
        async arrangeWindows() {
          return null;
        },
        async launchApp() {
          return null;
        },
        async focusTarget() {
          return null;
        },
        async openUrl() {
          return null;
        },
        async openProject() {
          return null;
        },
        async listNotifications() {
          return [];
        },
        async actOnNotification() {
          return null;
        },
        async setOverlayVisible(visible) {
          return {
            visible,
            changedAt: "2026-03-06T12:00:00.000Z",
          };
        },
      },
    });

    const state = await service.getState();

    expect(state.permissions).toEqual([
      {
        id: "perm-1",
        permission: "screen_recording",
        status: "not_determined",
      },
    ]);
    expect(state.health.reasons).toContain("desktop_session_unavailable");
    expect(state.health.reasons).toContain("permission_pending:screen_recording");
  });

  it("acquires a control lease and blocks competing owners", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    const first = await fixture.service.executeIntent({
      action: "request_control",
      actorId: "agent-1",
      actorKind: "agent",
      leaseTtlMs: 60_000,
    });
    const second = await fixture.service.executeIntent({
      action: "request_control",
      actorId: "agent-2",
      actorKind: "agent",
      leaseTtlMs: 60_000,
    });

    expect(first.status).toBe("completed");
    expect(first.controlLeaseId).toBeDefined();
    expect(second.status).toBe("blocked");
    expect(second.message).toContain("Control lease is currently held");
  });

  it("blocks clipboard read until approval exists", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    const result = await fixture.service.executeIntent({
      action: "clipboard_read",
      actorId: "agent-1",
      actorKind: "agent",
    });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("Approval required for clipboard_read");
  });

  it("allows clipboard read after approval is granted", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    const approval = await fixture.service.executeIntent({
      action: "approve",
      target: "clipboard_read",
      reason: "Allow clipboard access for testing",
    });
    const result = await fixture.service.executeIntent({
      action: "clipboard_read",
      actorId: "agent-1",
      actorKind: "agent",
    });

    expect(approval.status).toBe("completed");
    expect(result.status).toBe("completed");
    expect(result.payload).toMatchObject({
      content: "clipboard text",
      textPreview: "clipboard text",
    });
    expect(fixture.execCommand).toHaveBeenCalledWith("pbpaste", []);
  });

  it("blocks system mutations before side effects when canonical gate is enabled", async () => {
    const fixture = await createServiceFixtureWithOptions({ canonicalMutationGate: true });
    allocatedDbs.push(fixture.db);

    const result = await fixture.service.executeIntent({
      action: "clipboard_write",
      actorId: "agent-1",
      actorKind: "agent",
      value: "hello",
      idempotencyKey: "intent-1",
    });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("Canonical approval required");
    expect(fixture.execCommand).not.toHaveBeenCalledWith("bash", expect.any(Array));
  });

  it("allows system mutations with a matching canonical approval ticket", async () => {
    const fixture = await createServiceFixtureWithOptions({
      canonicalMutationGate: true,
      canonicalApprovalSecret: "test-canonical-secret",
    });
    allocatedDbs.push(fixture.db);
    const input: FridaySystemIntentInput = {
      action: "clipboard_write",
      actorId: "agent-1",
      actorKind: "agent",
      value: "hello",
      idempotencyKey: "intent-1",
    };
    const actionDigest = createFridayMutatingActionDigest(
      createFridaySystemIntentMutatingActionRequest(input, {
        surface: "system",
        defaultActorKind: "agent",
        defaultActorId: "agent-1",
      }),
    );

    const result = await fixture.service.executeIntent({
      ...input,
      canonicalApproval: signFridayCanonicalApproval(
        {
          decision: "approved",
          approvalId: "approval-1",
          decidedByPrincipalId: "user-1",
          actionDigest,
          expiresAt: "2026-03-06T12:10:00.000Z",
        },
        "test-canonical-secret",
      ),
    });

    expect(result.status).toBe("completed");
    expect(fixture.execCommand).toHaveBeenCalledWith("bash", ["-lc", `printf %s "$1" | pbcopy`, "--", "hello"]);
  });

  it("does not execute twice with the same canonical approval", async () => {
    const fixture = await createServiceFixtureWithOptions({
      canonicalMutationGate: true,
      canonicalApprovalSecret: "test-canonical-secret",
    });
    allocatedDbs.push(fixture.db);
    const input: FridaySystemIntentInput = {
      action: "clipboard_write",
      actorId: "agent-1",
      actorKind: "agent",
      value: "hello",
      idempotencyKey: "intent-1",
    };
    const actionDigest = createFridayMutatingActionDigest(
      createFridaySystemIntentMutatingActionRequest(input, {
        surface: "system",
        defaultActorKind: "agent",
        defaultActorId: "agent-1",
      }),
    );
    const canonicalApproval = signFridayCanonicalApproval(
      {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest,
        expiresAt: "2026-03-06T12:10:00.000Z",
      },
      "test-canonical-secret",
    );

    const first = await fixture.service.executeIntent({ ...input, canonicalApproval });
    const second = await fixture.service.executeIntent({ ...input, canonicalApproval });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("blocked");
    expect(second.message).toContain("canonical_approval_already_used");
    expect(fixture.execCommand).toHaveBeenCalledTimes(1);
  });

  it("blocks direct approval-rule mutators when canonical gate is enabled", async () => {
    const fixture = await createServiceFixtureWithOptions({ canonicalMutationGate: true });
    allocatedDbs.push(fixture.db);

    expect(() => fixture.service.upsertApprovalRule({
      action: "clipboard_read",
      riskLevel: "high",
      decision: "allow",
      rationale: "legacy bypass",
    })).toThrow("System approval rule mutations must go through the canonical approval gate.");
  });

  it("rejects forged canonical approvals when the server approval secret is configured", async () => {
    const fixture = await createServiceFixtureWithOptions({
      canonicalMutationGate: true,
      canonicalApprovalSecret: "test-canonical-secret",
    });
    allocatedDbs.push(fixture.db);
    const input: FridaySystemIntentInput = {
      action: "clipboard_write",
      actorId: "agent-1",
      actorKind: "agent",
      value: "hello",
      idempotencyKey: "intent-1",
    };
    const actionDigest = createFridayMutatingActionDigest(
      createFridaySystemIntentMutatingActionRequest(input, {
        surface: "system",
        defaultActorKind: "agent",
        defaultActorId: "agent-1",
      }),
    );

    const result = await fixture.service.executeIntent({
      ...input,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest,
        expiresAt: "2026-03-06T12:10:00.000Z",
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("canonical_approval_signature_invalid");
    expect(fixture.execCommand).not.toHaveBeenCalledWith("bash", expect.any(Array));
  });

  it("rejects approved canonical approvals when canonical gate has no signing secret", async () => {
    const fixture = await createServiceFixtureWithOptions({ canonicalMutationGate: true });
    allocatedDbs.push(fixture.db);
    const input: FridaySystemIntentInput = {
      action: "clipboard_write",
      actorId: "agent-1",
      actorKind: "agent",
      value: "hello",
      idempotencyKey: "intent-1",
    };
    const actionDigest = createFridayMutatingActionDigest(
      createFridaySystemIntentMutatingActionRequest(input, {
        surface: "system",
        defaultActorKind: "agent",
        defaultActorId: "agent-1",
      }),
    );

    const result = await fixture.service.executeIntent({
      ...input,
      canonicalApproval: {
        decision: "approved",
        approvalId: "approval-1",
        decidedByPrincipalId: "user-1",
        actionDigest,
        expiresAt: "2026-03-06T12:10:00.000Z",
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("canonical_approval_signature_invalid");
    expect(fixture.execCommand).not.toHaveBeenCalledWith("bash", expect.any(Array));
  });

  it("registers and revokes remote devices", async () => {
    const fixture = await createServiceFixtureWithOptions({ remoteMode: "trusted_private_network" });
    allocatedDbs.push(fixture.db);

    const device = fixture.service.registerRemoteDevice({
      label: "Test MacBook",
      fingerprint: "fp-123",
      credentialId: "cred-123",
    });
    const revoked = fixture.service.revokeRemoteDevice(device.id);

    expect(device.status).toBe("active");
    expect(device.platform).toBe("browser");
    expect(fixture.service.listRemoteDevices()).toHaveLength(1);
    expect(revoked?.status).toBe("revoked");
  });

  it("registers a passkey and requires an assertion before opening a remote session", async () => {
    const fixture = await createServiceFixtureWithOptions({ remoteMode: "trusted_private_network" });
    allocatedDbs.push(fixture.db);

    const device = fixture.service.registerRemoteDevice({
      label: "Test MacBook",
      fingerprint: "fp-passkey-1",
    });
    const registerOptions = await fixture.service.beginRemotePasskeyRegistration({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    const registration = await fixture.service.verifyRemotePasskeyRegistration({
      deviceId: device.id,
      challengeId: registerOptions.challengeId,
      response: { id: "cred-passkey-1" } as never,
    });

    await expect(fixture.service.openRemoteSession({
      deviceId: device.id,
      assertionToken: "missing-token",
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    })).rejects.toThrow("verified passkey assertion is required");

    const assertOptions = await fixture.service.beginRemotePasskeyAssertion({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    const assertion = await fixture.service.verifyRemotePasskeyAssertion({
      deviceId: device.id,
      challengeId: assertOptions.challengeId,
      response: { id: "cred-passkey-1" } as never,
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    });
    const session = await fixture.service.openRemoteSession({
      deviceId: device.id,
      assertionToken: assertion.assertionToken,
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    });

    expect(registerOptions.rpId).toBe("localhost");
    expect(registration.credentialId).toBe("cred-passkey-1");
    expect(registration.device.passkeyDeviceType).toBe("multiDevice");
    expect(registration.device.passkeyBackedUp).toBe(true);
    expect(assertion.device.id).toBe(device.id);
    expect(assertion.device.passkeyLastUsedAt).toBe(assertion.verifiedAt);
    expect(fixture.service.listRemoteDevices()[0]).toMatchObject({
      id: device.id,
      credentialId: "cred-passkey-1",
      passkeyDeviceType: "multiDevice",
      passkeyBackedUp: true,
    });
    expect(session.status).toBe("active");
    expect(session.devicePlatform).toBe("browser");
  });

  it("clears a trusted-device passkey and closes active remote sessions", async () => {
    const fixture = await createServiceFixtureWithOptions({ remoteMode: "trusted_private_network" });
    allocatedDbs.push(fixture.db);

    const device = fixture.service.registerRemoteDevice({
      label: "Test MacBook",
      fingerprint: "fp-passkey-clear-1",
    });
    const registerOptions = await fixture.service.beginRemotePasskeyRegistration({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    await fixture.service.verifyRemotePasskeyRegistration({
      deviceId: device.id,
      challengeId: registerOptions.challengeId,
      response: { id: "cred-passkey-clear-1" } as never,
    });
    const assertOptions = await fixture.service.beginRemotePasskeyAssertion({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    const assertion = await fixture.service.verifyRemotePasskeyAssertion({
      deviceId: device.id,
      challengeId: assertOptions.challengeId,
      response: { id: "cred-passkey-clear-1" } as never,
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    });
    const session = await fixture.service.openRemoteSession({
      deviceId: device.id,
      assertionToken: assertion.assertionToken,
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    });

    const cleared = await fixture.service.clearRemoteDevicePasskey(device.id);
    const sessions = fixture.service.listRemoteSessions({ deviceId: device.id });
    const events = fixture.service.listEvents();

    expect(cleared.id).toBe(device.id);
    expect(cleared.credentialId).toBeUndefined();
    expect(cleared.passkeyRegisteredAt).toBeUndefined();
    expect(cleared.passkeyLastUsedAt).toBeUndefined();
    expect(sessions.find((item) => item.id === session.id)?.closedReason).toBe("passkey_cleared");
    expect(events.map((event) => event.event)).toContain("system.remote_passkey.cleared");
    await expect(fixture.service.beginRemotePasskeyAssertion({
      deviceId: device.id,
      origin: "http://localhost:3141",
    })).rejects.toThrow("verified passkey is required");
  });

  it("opens, heartbeats, and closes trusted remote sessions", async () => {
    const fixture = await createServiceFixtureWithOptions({ remoteMode: "trusted_private_network" });
    allocatedDbs.push(fixture.db);

    const device = fixture.service.registerRemoteDevice({
      label: "Test MacBook",
      fingerprint: "fp-remote-1",
    });
    const registrationOptions = await fixture.service.beginRemotePasskeyRegistration({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    await fixture.service.verifyRemotePasskeyRegistration({
      deviceId: device.id,
      challengeId: registrationOptions.challengeId,
      response: { id: "cred-remote-1" } as never,
    });
    const assertionOptions = await fixture.service.beginRemotePasskeyAssertion({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    const assertion = await fixture.service.verifyRemotePasskeyAssertion({
      deviceId: device.id,
      challengeId: assertionOptions.challengeId,
      response: { id: "cred-remote-1" } as never,
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    });
    const session = await fixture.service.openRemoteSession({
      deviceId: device.id,
      assertionToken: assertion.assertionToken,
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    });
    const heartbeat = await fixture.service.touchRemoteSession(session.id, {
      ipAddress: "192.168.1.24",
      userAgent: "AgentOS Remote",
    });
    const closed = await fixture.service.closeRemoteSession(session.id, "operator_closed");

    expect(session.status).toBe("active");
    expect(heartbeat?.status).toBe("active");
    expect(new Date(heartbeat!.lastSeenAt).getTime()).toBeGreaterThanOrEqual(new Date(session.lastSeenAt).getTime());
    expect(closed?.status).toBe("closed");
    expect(closed?.closedReason).toBe("operator_closed");
    expect(fixture.service.listRemoteSessions()).toHaveLength(1);
  });

  it("rejects remote sessions from public networks when trusted-private mode is enabled", async () => {
    const fixture = await createServiceFixtureWithOptions({ remoteMode: "trusted_private_network" });
    allocatedDbs.push(fixture.db);

    const device = fixture.service.registerRemoteDevice({
      label: "Test MacBook",
      fingerprint: "fp-remote-public",
    });
    const registrationOptions = await fixture.service.beginRemotePasskeyRegistration({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    await fixture.service.verifyRemotePasskeyRegistration({
      deviceId: device.id,
      challengeId: registrationOptions.challengeId,
      response: { id: "cred-remote-public" } as never,
    });
    const assertionOptions = await fixture.service.beginRemotePasskeyAssertion({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    const assertion = await fixture.service.verifyRemotePasskeyAssertion({
      deviceId: device.id,
      challengeId: assertionOptions.challengeId,
      response: { id: "cred-remote-public" } as never,
      ipAddress: "192.168.1.24",
      userAgent: "Trusted Client",
    });

    await expect(fixture.service.openRemoteSession({
      deviceId: device.id,
      assertionToken: assertion.assertionToken,
      ipAddress: "8.8.8.8",
      userAgent: "Public Client",
    })).rejects.toThrow("restricted to private-network clients");
  });

  it("revoking a device closes its active remote sessions", async () => {
    const fixture = await createServiceFixtureWithOptions({ remoteMode: "trusted_private_network" });
    allocatedDbs.push(fixture.db);

    const device = fixture.service.registerRemoteDevice({
      label: "Test MacBook",
      fingerprint: "fp-remote-revoke",
    });
    const registrationOptions = await fixture.service.beginRemotePasskeyRegistration({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    await fixture.service.verifyRemotePasskeyRegistration({
      deviceId: device.id,
      challengeId: registrationOptions.challengeId,
      response: { id: "cred-remote-revoke" } as never,
    });
    const assertionOptions = await fixture.service.beginRemotePasskeyAssertion({
      deviceId: device.id,
      origin: "http://localhost:3141",
    });
    const assertion = await fixture.service.verifyRemotePasskeyAssertion({
      deviceId: device.id,
      challengeId: assertionOptions.challengeId,
      response: { id: "cred-remote-revoke" } as never,
      ipAddress: "10.0.0.8",
      userAgent: "Trusted Client",
    });
    const session = await fixture.service.openRemoteSession({
      deviceId: device.id,
      assertionToken: assertion.assertionToken,
      ipAddress: "10.0.0.8",
      userAgent: "Trusted Client",
    });
    const revoked = fixture.service.revokeRemoteDevice(device.id);
    const sessions = fixture.service.listRemoteSessions({ deviceId: device.id });

    expect(revoked?.status).toBe("revoked");
    expect(sessions[0]?.id).toBe(session.id);
    expect(sessions[0]?.status).toBe("closed");
    expect(sessions[0]?.closedReason).toBe("device_revoked");
  });

  it("arranges windows through the companion when supported", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    const result = await fixture.service.executeIntent({
      action: "arrange_windows",
      actorId: "agent-1",
      actorKind: "agent",
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("Arranged 1 window");
    expect(result.payload).toMatchObject({
      layout: "single_focus",
      arrangedWindowIds: ["window:finder:1"],
    });
  });

  it("acts on notifications through the companion bridge", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    await fixture.service.executeIntent({
      action: "approve",
      target: "notification_act",
      reason: "Allow notification actions for testing",
    });
    const result = await fixture.service.executeIntent({
      action: "notification_act",
      actorId: "agent-1",
      actorKind: "agent",
      notificationId: "notif-1",
      notificationAction: "mark_read",
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("Notification mark_read completed");
    expect(result.payload).toMatchObject({
      action: "mark_read",
      notification: {
        id: "notif-1",
        read: true,
      },
    });
  });

  it("marks notification actions unavailable when the companion does not support them", async () => {
    const baseBridge = createCompanionBridge();
    const fixture = await createServiceFixtureWithOptions({
      companionBridge: {
        ...baseBridge,
        async getStatus() {
          const status = await baseBridge.getStatus();
          return {
            ...status,
            capabilities: createCompanionCapabilities(false),
          };
        },
      },
    });
    allocatedDbs.push(fixture.db);

    await fixture.service.executeIntent({
      action: "approve",
      target: "notification_act",
      reason: "Allow notification actions for testing",
    });
    const result = await fixture.service.executeIntent({
      action: "notification_act",
      actorId: "agent-1",
      actorKind: "agent",
      notificationId: "notif-1",
      notificationAction: "mark_read",
    });

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("Notification action is unavailable");
  });

  it("marks window arrangement unavailable when the companion does not support it", async () => {
    const baseBridge = createCompanionBridge();
    const fixture = await createServiceFixtureWithOptions({
      companionBridge: {
        ...baseBridge,
        async getStatus() {
          const status = await baseBridge.getStatus();
          return {
            ...status,
            capabilities: {
              ...createCompanionCapabilities(true),
              actions: {
                ...createCompanionCapabilities(true).actions,
                arrange_windows: "unsupported" as const,
              },
            },
          };
        },
      },
    });
    allocatedDbs.push(fixture.db);

    const result = await fixture.service.executeIntent({
      action: "arrange_windows",
      actorId: "agent-1",
      actorKind: "agent",
    });

    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("Window arrangement is unavailable");
  });

  it("focuses applications through the companion bridge", async () => {
    const fixture = await createServiceFixture();
    allocatedDbs.push(fixture.db);

    const result = await fixture.service.executeIntent({
      action: "focus",
      actorId: "agent-1",
      actorKind: "agent",
      appIdentifier: "Finder",
    });

    expect(result.status).toBe("completed");
    expect(result.payload).toMatchObject({
      appIdentifier: "Finder",
      focused: true,
    });
  });

  it("rejects multiline focus app identifiers before calling the companion bridge", async () => {
    const focusTarget = vi.fn(async (input: { appIdentifier?: string; windowId?: string }) => ({
      appIdentifier: input.appIdentifier,
      windowId: input.windowId,
      focused: true,
      focusedAt: "2026-03-06T12:00:00.000Z",
    }));
    const fixture = await createServiceFixtureWithOptions({
      companionBridge: {
        ...createCompanionBridge(),
        focusTarget,
      },
    });
    allocatedDbs.push(fixture.db);

    await expect(
      fixture.service.executeIntent({
        action: "focus",
        actorId: "agent-1",
        actorKind: "agent",
        appIdentifier: "Finder\nbeep",
      }),
    ).rejects.toThrow("Unsafe AppleScript app identifier");
    expect(focusTarget).not.toHaveBeenCalled();
  });

  it("blocks remote device registration when trusted-device remote access is disabled", async () => {
    const fixture = await createServiceFixtureWithOptions({
      remoteMode: "disabled",
    });
    allocatedDbs.push(fixture.db);

    expect(() => fixture.service.registerRemoteDevice({
      label: "Test MacBook",
      fingerprint: "fp-disabled",
    })).toThrow("Trusted-device remote access is disabled");
  });

  it("recovers active task and safe mode state from the journal after restart", async () => {
    const db = createTestDb();
    allocatedDbs.push(db);

    const firstFixture = await createServiceFixtureWithOptions({
      db,
      execCommand: async (command: string) => {
        if (command === "bash") {
          return { exitCode: 1, stdout: "", stderr: "pbcopy unavailable" };
        }
        if (command === "pbpaste") {
          return { exitCode: 0, stdout: "clipboard text", stderr: "" };
        }
        if (command === "rg") {
          return { exitCode: 0, stdout: "src/app.ts\nREADME.md\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const taskResult = await firstFixture.service.executeIntent({
      action: "resume_task",
      actorId: "agent-1",
      actorKind: "agent",
      value: "finish-restart-recovery",
    });
    const failureResult = await firstFixture.service.executeIntent({
      action: "clipboard_write",
      actorId: "agent-1",
      actorKind: "agent",
      value: "force-safe-mode",
    });

    expect(taskResult.status).toBe("completed");
    expect(failureResult.status).toBe("failed");

    const secondFixture = await createServiceFixtureWithOptions({ db });
    const recoveredState = await secondFixture.service.getState();

    expect(recoveredState.activeTask).toBe("finish-restart-recovery");
    expect(recoveredState.health.status).toBe("safe_mode");

    const recoveryResult = await secondFixture.service.executeIntent({
      action: "recover_ui",
      actorId: "agent-1",
      actorKind: "agent",
    });
    const events = secondFixture.service.listEvents();

    expect(recoveryResult.status).toBe("completed");
    expect(events.map((event) => event.event)).toContain("system.task.updated");
    expect(events.map((event) => event.event)).toContain("system.safe_mode.entered");
    expect(events.map((event) => event.event)).toContain("system.safe_mode.exited");
  });

  it("does not report recover_ui completed when the companion bridge is unavailable", async () => {
    const companionBridge = createFridaySystemUnavailableCompanionBridge({
      id: "companion-unavailable",
      platform: "darwin",
      nowIso: createNowIso(),
      launchAtLoginEnabled: false,
      panicHotkey: "cmd+shift+escape",
      menuBarEnabled: false,
      overlayEnabled: false,
      unavailableReason: "companion socket blocked",
    });
    const fixture = await createServiceFixtureWithOptions({ companionBridge });
    allocatedDbs.push(fixture.db);

    const result = await fixture.service.executeIntent({
      action: "recover_ui",
      actorId: "agent-1",
      actorKind: "agent",
    });
    const events = fixture.service.listEvents();

    expect(result.status).toBe("failed");
    expect(result.message).toBe("companion socket blocked");
    expect(events.map((event) => event.event)).toContain("system.intent.failed");
    expect(events.map((event) => event.event)).not.toContain("system.safe_mode.exited");
  });
});
