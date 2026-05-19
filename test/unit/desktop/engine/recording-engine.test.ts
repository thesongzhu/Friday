import { describe, it, expect, beforeEach } from "vitest";
import { createRecordingEngine } from "../../../../src/desktop/engine/recording-engine.js";
import type { RecordingEngine } from "../../../../src/desktop/engine/recording-engine.js";
import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
} from "../../../../src/desktop/model/friday-desktop.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
let idCounter = 0;

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
    platform: "darwin" as const,
    principalId: "user-1",
  };
}

function makeActionResult(action: FridayDesktopAction): FridayDesktopActionResult {
  return {
    id: `result-${++idCounter}`,
    action,
    status: "success",
    platform: "darwin",
    durationMs: 15,
    startedAt: NOW,
    completedAt: NOW,
  };
}

// ─── Tests ───

describe("RecordingEngine", () => {
  let engine: RecordingEngine;

  beforeEach(() => {
    idCounter = 0;
    engine = createRecordingEngine(makeConfig());
  });

  describe("start", () => {
    it("creates a recording in 'recording' state", () => {
      const rec = engine.start({ name: "Test Recording" });

      expect(rec.name).toBe("Test Recording");
      expect(rec.state).toBe("recording");
      expect(rec.platform).toBe("darwin");
      expect(rec.stepCount).toBe(0);
      expect(rec.createdBy).toBe("user-1");
    });

    it("stores description and tags", () => {
      const rec = engine.start({
        name: "Tagged",
        description: "A test",
        tags: ["ui", "login"],
      });

      expect(rec.description).toBe("A test");
      expect(rec.tags).toEqual(["ui", "login"]);
    });
  });

  describe("lifecycle transitions", () => {
    it("transitions recording → paused", () => {
      const rec = engine.start({ name: "R1" });
      const paused = engine.pause(rec.id);

      expect(paused.state).toBe("paused");
    });

    it("transitions paused → recording (resume)", () => {
      const rec = engine.start({ name: "R1" });
      engine.pause(rec.id);
      const resumed = engine.resume(rec.id);

      expect(resumed.state).toBe("recording");
    });

    it("transitions recording → stopped", () => {
      const rec = engine.start({ name: "R1" });
      const stopped = engine.stop(rec.id);

      expect(stopped.state).toBe("stopped");
      expect(stopped.stoppedAt).toBe(NOW);
    });

    it("transitions paused → stopped", () => {
      const rec = engine.start({ name: "R1" });
      engine.pause(rec.id);
      const stopped = engine.stop(rec.id);

      expect(stopped.state).toBe("stopped");
    });

    it("throws on invalid transition: stopped → recording", () => {
      const rec = engine.start({ name: "R1" });
      engine.stop(rec.id);

      expect(() => engine.resume(rec.id)).toThrow("DESKTOP_RECORDING_INVALID_STATE");
    });

    it("throws on invalid transition: recording → idle", () => {
      const rec = engine.start({ name: "R1" });

      // No API to go back to idle, but the state machine should still block it
      expect(() => engine.resume(rec.id)).toThrow("DESKTOP_RECORDING_INVALID_STATE");
    });

    it("throws for non-existent recording", () => {
      expect(() => engine.stop("nonexistent")).toThrow("DESKTOP_RECORDING_NOT_FOUND");
    });
  });

  describe("captureStep", () => {
    it("captures a step with action and result", () => {
      const rec = engine.start({ name: "R1" });
      const action: FridayDesktopAction = { type: "click" };
      const result = makeActionResult(action);

      const step = engine.captureStep(rec.id, action, result);

      expect(step.stepIndex).toBe(0);
      expect(step.action).toBe(action);
      expect(step.result).toBe(result);
      expect(step.recordingId).toBe(rec.id);
    });

    it("increments step index for each captured step", () => {
      const rec = engine.start({ name: "R1" });

      engine.captureStep(rec.id, { type: "click" });
      engine.captureStep(rec.id, { type: "type", text: "hello" });
      const third = engine.captureStep(rec.id, { type: "keypress", key: "Enter" });

      expect(third.stepIndex).toBe(2);
    });

    it("updates step count on the recording", () => {
      const rec = engine.start({ name: "R1" });

      engine.captureStep(rec.id, { type: "click" });
      engine.captureStep(rec.id, { type: "click" });

      const updated = engine.getRecording(rec.id)!;
      expect(updated.stepCount).toBe(2);
    });

    it("throws when recording is not in 'recording' state", () => {
      const rec = engine.start({ name: "R1" });
      engine.pause(rec.id);

      expect(() => engine.captureStep(rec.id, { type: "click" })).toThrow(
        "DESKTOP_RECORDING_INVALID_STATE",
      );
    });

    it("stores parameter bindings", () => {
      const rec = engine.start({ name: "R1" });

      const step = engine.captureStep(
        rec.id,
        { type: "type", text: "{{email}}" },
        undefined,
        undefined,
        { email: "test@example.com" },
      );

      expect(step.parameterBindings).toEqual({ email: "test@example.com" });
    });
  });

  describe("getSteps", () => {
    it("returns all steps for a recording", () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(rec.id, { type: "click" });
      engine.captureStep(rec.id, { type: "type", text: "hi" });

      const steps = engine.getSteps(rec.id);
      expect(steps).toHaveLength(2);
    });

    it("returns empty array for nonexistent recording", () => {
      expect(engine.getSteps("nonexistent")).toEqual([]);
    });
  });

  describe("listRecordings", () => {
    it("lists all recordings", () => {
      engine.start({ name: "R1" });
      engine.start({ name: "R2" });

      expect(engine.listRecordings()).toHaveLength(2);
    });
  });

  describe("deleteRecording", () => {
    it("deletes a recording and its steps", () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(rec.id, { type: "click" });

      expect(engine.deleteRecording(rec.id)).toBe(true);
      expect(engine.getRecording(rec.id)).toBeNull();
      expect(engine.getSteps(rec.id)).toEqual([]);
    });

    it("returns false for nonexistent recording", () => {
      expect(engine.deleteRecording("nonexistent")).toBe(false);
    });
  });

  describe("addParameter", () => {
    it("adds a parameter to the recording", () => {
      const rec = engine.start({ name: "R1" });

      const updated = engine.addParameter(rec.id, "email", {
        type: "string",
        defaultValue: "user@example.com",
        description: "Email address",
        required: true,
      });

      expect(updated.parameters.email).toBeDefined();
      expect(updated.parameters.email.type).toBe("string");
      expect(updated.parameters.email.defaultValue).toBe("user@example.com");
    });
  });

  describe("replay", () => {
    it("replays all steps through the executor", async () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(rec.id, { type: "click" });
      engine.captureStep(rec.id, { type: "type", text: "hello" });
      engine.stop(rec.id);

      const executedActions: FridayDesktopAction[] = [];
      const result = await engine.replay(rec.id, async (action) => {
        executedActions.push(action);
        return makeActionResult(action);
      });

      expect(result.allSucceeded).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(executedActions).toHaveLength(2);
    });

    it("stops on failure when stopOnFailure is true", async () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(rec.id, { type: "click" });
      engine.captureStep(rec.id, { type: "click" });
      engine.captureStep(rec.id, { type: "click" });
      engine.stop(rec.id);

      let callCount = 0;
      const result = await engine.replay(
        rec.id,
        async (action) => {
          callCount++;
          if (callCount === 1) {
            return { ...makeActionResult(action), status: "failed" as const };
          }
          return makeActionResult(action);
        },
        { stopOnFailure: true },
      );

      expect(result.failureCount).toBe(1);
      expect(result.skippedCount).toBe(2);
      expect(result.allSucceeded).toBe(false);
    });

    it("continues on failure when stopOnFailure is false", async () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(rec.id, { type: "click" });
      engine.captureStep(rec.id, { type: "click" });
      engine.stop(rec.id);

      let callCount = 0;
      const result = await engine.replay(
        rec.id,
        async (action) => {
          callCount++;
          if (callCount === 1) {
            return { ...makeActionResult(action), status: "failed" as const };
          }
          return makeActionResult(action);
        },
        { stopOnFailure: false },
      );

      expect(result.failureCount).toBe(1);
      expect(result.successCount).toBe(1);
      expect(result.skippedCount).toBe(0);
    });

    it("substitutes parameters during replay", async () => {
      const rec = engine.start({ name: "R1" });
      engine.addParameter(rec.id, "email", {
        type: "string",
        defaultValue: "default@test.com",
        required: true,
      });
      engine.captureStep(
        rec.id,
        { type: "type", text: "{{email}}" },
        undefined,
        undefined,
        { email: "original@test.com" },
      );
      engine.stop(rec.id);

      let capturedAction: FridayDesktopAction | null = null;
      await engine.replay(
        rec.id,
        async (action) => {
          capturedAction = action;
          return makeActionResult(action);
        },
        { parameters: { email: "replay@test.com" } },
      );

      expect(capturedAction).not.toBeNull();
      expect((capturedAction as any).text).toBe("replay@test.com");
    });

    it("uses default parameter values when replay values are not provided", async () => {
      const rec = engine.start({ name: "R1" });
      engine.addParameter(rec.id, "name", {
        type: "string",
        defaultValue: "DefaultName",
        required: false,
      });
      engine.captureStep(rec.id, { type: "type", text: "{{name}}" });
      engine.stop(rec.id);

      let capturedAction: FridayDesktopAction | null = null;
      await engine.replay(rec.id, async (action) => {
        capturedAction = action;
        return makeActionResult(action);
      });

      expect((capturedAction as any).text).toBe("DefaultName");
    });

    it("only substitutes placeholders that were bound at capture time", async () => {
      const rec = engine.start({ name: "R1" });
      engine.addParameter(rec.id, "email", {
        type: "string",
        defaultValue: "default-email@test.com",
        required: true,
      });
      engine.addParameter(rec.id, "token", {
        type: "string",
        defaultValue: "default-token",
        required: true,
      });

      engine.captureStep(
        rec.id,
        { type: "type", text: "{{email}}/{{token}}" },
        undefined,
        undefined,
        { email: "captured-email@test.com" },
      );
      engine.stop(rec.id);

      let capturedAction: FridayDesktopAction | null = null;
      await engine.replay(
        rec.id,
        async (action) => {
          capturedAction = action;
          return makeActionResult(action);
        },
        {
          parameters: {
            email: "replay-email@test.com",
            token: "replay-token",
          },
        },
      );

      expect(capturedAction).not.toBeNull();
      expect((capturedAction as any).text).toBe("replay-email@test.com/{{token}}");
    });

    it("falls back to captured binding value when no replay/default value exists", async () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(
        rec.id,
        { type: "type", text: "{{env}}" },
        undefined,
        undefined,
        { env: "staging" },
      );
      engine.stop(rec.id);

      let capturedAction: FridayDesktopAction | null = null;
      await engine.replay(rec.id, async (action) => {
        capturedAction = action;
        return makeActionResult(action);
      });

      expect(capturedAction).not.toBeNull();
      expect((capturedAction as any).text).toBe("staging");
    });

    it("preserves placeholder when no binding, replay value, or default exists", async () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(
        rec.id,
        { type: "type", text: "Hello {{unknown}}" },
        undefined,
        undefined,
        {},
      );
      engine.stop(rec.id);

      let capturedAction: FridayDesktopAction | null = null;
      await engine.replay(rec.id, async (action) => {
        capturedAction = action;
        return makeActionResult(action);
      });

      expect(capturedAction).not.toBeNull();
      expect((capturedAction as any).text).toBe("Hello {{unknown}}");
    });

    it("preserves prototype-chain key placeholders like {{toString}}", async () => {
      const rec = engine.start({ name: "R1" });
      engine.captureStep(
        rec.id,
        { type: "type", text: "{{toString}} and {{constructor}}" },
        undefined,
        undefined,
        { email: "test@test.com" },
      );
      engine.stop(rec.id);

      let capturedAction: FridayDesktopAction | null = null;
      await engine.replay(rec.id, async (action) => {
        capturedAction = action;
        return makeActionResult(action);
      });

      expect(capturedAction).not.toBeNull();
      expect((capturedAction as any).text).toBe("{{toString}} and {{constructor}}");
    });

    it("substitutes string values without rewriting serialized JSON", async () => {
      const rec = engine.start({ name: "R1" });
      engine.addParameter(rec.id, "message", {
        type: "string",
        defaultValue: "default",
        required: true,
      });
      engine.captureStep(
        rec.id,
        {
          type: "type",
          text: "Message: {{message}}",
          selector: {
            strategy: "accessibility_id",
            value: "composer-{{message}}",
            appBundleId: "com.example.app",
          },
        } as FridayDesktopAction,
        undefined,
        undefined,
        { message: "original" },
      );
      engine.stop(rec.id);

      let capturedAction: FridayDesktopAction | null = null;
      await engine.replay(
        rec.id,
        async (action) => {
          capturedAction = action;
          return makeActionResult(action);
        },
        { parameters: { message: "quote \" slash \\ newline\nvalue" } },
      );

      expect(capturedAction).not.toBeNull();
      expect((capturedAction as any).text).toBe("Message: quote \" slash \\ newline\nvalue");
      expect((capturedAction as any).selector.value).toBe("composer-quote \" slash \\ newline\nvalue");
      expect((capturedAction as any).selector.appBundleId).toBe("com.example.app");
    });

    it("does not substitute object keys or non-string fields", async () => {
      const rec = engine.start({ name: "R1" });
      engine.addParameter(rec.id, "value", {
        type: "string",
        defaultValue: "replacement",
        required: false,
      });
      engine.captureStep(
        rec.id,
        {
          type: "click",
          selector: {
            strategy: "accessibility_id",
            value: "{{value}}",
            appBundleId: "com.example.app",
          },
          coordinates: { x: 10, y: 20, width: 30, height: 40 },
          metadata: { "{{value}}": 7, nested: true },
        } as unknown as FridayDesktopAction,
      );
      engine.stop(rec.id);

      let capturedAction: any = null;
      await engine.replay(rec.id, async (action) => {
        capturedAction = action;
        return makeActionResult(action);
      });

      expect(capturedAction.selector.value).toBe("replacement");
      expect(capturedAction.coordinates).toEqual({ x: 10, y: 20, width: 30, height: 40 });
      expect(capturedAction.metadata).toEqual({ "{{value}}": 7, nested: true });
    });

    it("throws when recording is not stopped", async () => {
      const rec = engine.start({ name: "R1" });

      await expect(
        engine.replay(rec.id, async (a) => makeActionResult(a)),
      ).rejects.toThrow("DESKTOP_RECORDING_INVALID_STATE");
    });

    it("throws for nonexistent recording", async () => {
      await expect(
        engine.replay("bad-id", async (a) => makeActionResult(a)),
      ).rejects.toThrow("DESKTOP_RECORDING_NOT_FOUND");
    });
  });
});
