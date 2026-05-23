import { describe, it, expect } from "vitest";
import { createFridayRecordingConverter } from "../../../../../src/skills/converter/converters/friday-recording-converter.js";
import type {
  FridaySkillConversionSource,
  FridaySkillConverterContext,
} from "../../../../../src/skills/converter/model/friday-skill-converter.types.js";

// ─── Helpers ───

function makeRecording(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-001",
    name: "Login Flow",
    description: "Logs into the web app",
    state: "stopped",
    platform: "darwin",
    parameters: {
      username: {
        type: "string",
        defaultValue: "admin",
        description: "Login username",
        required: true,
      },
      password: {
        type: "string",
        description: "Login password",
        required: true,
      },
    },
    tags: ["login", "web"],
    stepCount: 3,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    stoppedAt: "2026-01-01T00:01:00Z",
    steps: [
      {
        id: "step-1",
        recordingId: "rec-001",
        stepIndex: 0,
        action: { type: "click", coordinates: { x: 100, y: 200 }, clickType: "single", button: "left" },
        result: { status: "success", platform: "darwin", durationMs: 50 },
        parameterBindings: {},
        timestamp: "2026-01-01T00:00:01Z",
        durationMs: 50,
      },
      {
        id: "step-2",
        recordingId: "rec-001",
        stepIndex: 1,
        action: { type: "type", text: "{{username}}" },
        result: { status: "success", platform: "darwin", durationMs: 120 },
        parameterBindings: { username: "admin" },
        timestamp: "2026-01-01T00:00:02Z",
        durationMs: 120,
      },
      {
        id: "step-3",
        recordingId: "rec-001",
        stepIndex: 2,
        action: { type: "type", text: "{{password}}" },
        result: { status: "success", platform: "darwin", durationMs: 80 },
        parameterBindings: { password: "secret" },
        timestamp: "2026-01-01T00:00:03Z",
        durationMs: 80,
      },
    ],
    ...overrides,
  };
}

function toBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function makeSource(rec: unknown): FridaySkillConversionSource {
  return { contentBase64: toBase64(rec) };
}

function makeCtx(): FridaySkillConverterContext {
  return {
    workspaceDir: "/tmp/test-workspace",
    managedSkillsDir: "/tmp/test-skills",
    nowIso: () => "2026-02-25T12:00:00Z",
  };
}

// ─── Tests ───

describe("FridayRecordingConverter", () => {
  const converter = createFridayRecordingConverter();

  // ── Converter Identity ──

  describe("identity", () => {
    it("has expected id, displayName, and priority", () => {
      expect(converter.id).toBe("desktop-recording");
      expect(converter.displayName).toBe("Desktop Recording");
      expect(converter.priority).toBe(60);
    });
  });

  // ── Detection ──

  describe("detect", () => {
    it("detects a valid recording with high confidence", async () => {
      const rec = makeRecording();
      const result = await converter.detect(makeSource(rec));

      expect(result).not.toBeNull();
      expect(result!.converterId).toBe("desktop-recording");
      expect(result!.format).toBe("desktop-recording");
      expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result!.reasons.length).toBeGreaterThan(0);
    });

    it("returns null for non-base64 source", async () => {
      const result = await converter.detect({ uri: "/some/path" });
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", async () => {
      const result = await converter.detect({
        contentBase64: Buffer.from("not json").toString("base64"),
      });
      expect(result).toBeNull();
    });

    it("returns null for JSON missing recording fields", async () => {
      const result = await converter.detect(
        makeSource({ foo: "bar", baz: 123 }),
      );
      expect(result).toBeNull();
    });

    it("returns null for object with id/name/platform but no steps array", async () => {
      const result = await converter.detect(
        makeSource({ id: "x", name: "y", platform: "darwin" }),
      );
      expect(result).toBeNull();
    });

    it("detects recording without parameters (lower confidence)", async () => {
      const rec = makeRecording({ parameters: {} });
      const result = await converter.detect(makeSource(rec));
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("detects recording with steps that have typed actions", async () => {
      const rec = makeRecording();
      const result = await converter.detect(makeSource(rec));
      expect(result!.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining("typed desktop actions")]),
      );
    });
  });

  // ── Conversion — Manifest ──

  describe("convert → manifest", () => {
    it("produces a valid manifest with schemaVersion 2.0", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());

      expect(result.drafts).toHaveLength(1);
      const { manifest } = result.drafts[0];
      expect(manifest.schemaVersion).toBe("2.0");
      expect(manifest.id).toBe("desktop-recording-rec-001");
      expect(manifest.name).toBe("Login Flow");
      expect(manifest.kind).toBe("workflow");
      expect(manifest.category).toBe("automation");
    });

    it("maps parameters to manifest inputs", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const { manifest } = result.drafts[0];

      expect(manifest.inputs).toHaveLength(2);
      expect(manifest.inputs[0].key).toBe("username");
      expect(manifest.inputs[0].type).toBe("string");
      expect(manifest.inputs[0].required).toBe(true);
      expect(manifest.inputs[0].defaultValue).toBe("admin");

      expect(manifest.inputs[1].key).toBe("password");
      expect(manifest.inputs[1].required).toBe(true);
    });

    it("sets correct OS target from platform", async () => {
      const rec = makeRecording({ platform: "win32" });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.requirements.os).toEqual(["win32"]);
    });

    it("sets all platforms for unknown platform", async () => {
      const rec = makeRecording({ platform: "unknown" });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.requirements.os).toEqual([
        "darwin",
        "linux",
        "win32",
      ]);
    });

    it("adds desktop-recording and automation tags", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.tags).toContain("desktop-recording");
      expect(result.drafts[0].manifest.tags).toContain("automation");
      expect(result.drafts[0].manifest.tags).toContain("login");
    });

    it("sets runtime timeout based on step count", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      // 3 steps × 5000ms = 15000ms, but min is 30000
      expect(result.drafts[0].manifest.runtime.timeoutMsDefault).toBe(30_000);
    });

    it("scales timeout for many steps", async () => {
      const manySteps = Array.from({ length: 20 }, (_, i) => ({
        id: `step-${i}`,
        recordingId: "rec-001",
        stepIndex: i,
        action: { type: "click", coordinates: { x: 0, y: 0 }, clickType: "single", button: "left" },
        parameterBindings: {},
        timestamp: "2026-01-01T00:00:00Z",
      }));
      const rec = makeRecording({ steps: manySteps, stepCount: 20 });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.runtime.timeoutMsDefault).toBe(100_000);
    });

    it("sets correct permissions for desktop control", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const { permissions } = result.drafts[0].manifest;
      expect(permissions.grants).toHaveLength(2);
      expect(permissions.grants[0].resource).toBe("device");
      expect(permissions.grants[0].action).toBe("execute");
      expect(permissions.promptOn).toContain("device.capture");
    });

    it("uses recording description when present", async () => {
      const rec = makeRecording({ description: "Custom description" });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.description).toBe("Custom description");
    });

    it("generates fallback description when none provided", async () => {
      const rec = makeRecording({ description: undefined });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.description).toContain("Login Flow");
    });
  });

  // ── Conversion — UI Schema ──

  describe("convert → uiSchema", () => {
    it("generates UI schema with fields matching parameters", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const { uiSchema } = result.drafts[0];

      expect(uiSchema.schemaVersion).toBe("1.0");
      expect(uiSchema.title).toBe("Login Flow");
      expect(uiSchema.fields).toHaveLength(2);
      expect(uiSchema.fields[0].inputKey).toBe("username");
      expect(uiSchema.fields[0].kind).toBe("text");
      expect(uiSchema.fields[1].inputKey).toBe("password");
    });

    it("maps number parameter to number field kind", async () => {
      const rec = makeRecording({
        parameters: {
          count: { type: "number", required: false, description: "Repeat count" },
        },
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].uiSchema.fields[0].kind).toBe("number");
    });

    it("maps boolean parameter to toggle field kind", async () => {
      const rec = makeRecording({
        parameters: {
          verbose: { type: "boolean", required: false },
        },
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].uiSchema.fields[0].kind).toBe("toggle");
    });

    it("maps selector parameter to json field kind", async () => {
      const rec = makeRecording({
        parameters: {
          target: { type: "selector", required: true },
        },
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].uiSchema.fields[0].kind).toBe("json");
    });

    it("has Replay and Reset actions", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const { uiSchema } = result.drafts[0];
      expect(uiSchema.actions).toEqual([
        { id: "run", label: "Replay", style: "primary" },
        { id: "reset", label: "Reset", style: "secondary" },
      ]);
    });

    it("uses table widget for array outputs", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const stepOutput = result.drafts[0].uiSchema.outputs.find(
        (o) => o.outputKey === "stepResults",
      );
      expect(stepOutput?.widget).toBe("table");
    });
  });

  // ── Conversion — Files ──

  describe("convert → files", () => {
    it("generates 3 files: entrypoint, steps JSON, metadata JSON", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const { files } = result.drafts[0];

      expect(files).toHaveLength(3);
      expect(files.map((f) => f.path)).toEqual([
        "entrypoint.js",
        "recording-steps.json",
        "recording-metadata.json",
      ]);
    });

    it("entrypoint references recording-steps.json", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const entrypoint = result.drafts[0].files.find(
        (f) => f.path === "entrypoint.js",
      );
      expect(entrypoint!.content).toContain("recording-steps.json");
      expect(entrypoint!.content).toContain("import.meta.url");
      expect(entrypoint!.content).toContain("fileURLToPath");
      expect(entrypoint!.content).not.toContain("__dirname");
    });

    it("entrypoint contains parameter substitution when params exist", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const entrypoint = result.drafts[0].files.find(
        (f) => f.path === "entrypoint.js",
      );
      expect(entrypoint!.content).toContain("substituteParameters");
      expect(entrypoint!.content).toContain("function substituteValue");
      expect(entrypoint!.content).toContain("Object.entries(value)");
      expect(entrypoint!.content).not.toContain("JSON.stringify(action)");
      expect(entrypoint!.content).not.toContain("JSON.parse(substituted)");
    });

    it("entrypoint skips parameter substitution when no params", async () => {
      const rec = makeRecording({ parameters: {} });
      const result = await converter.convert(makeSource(rec), makeCtx());
      const entrypoint = result.drafts[0].files.find(
        (f) => f.path === "entrypoint.js",
      );
      expect(entrypoint!.content).not.toContain("substituteParameters");
    });

    it("entrypoint includes recording metadata comment", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const entrypoint = result.drafts[0].files.find(
        (f) => f.path === "entrypoint.js",
      );
      expect(entrypoint!.content).toContain("Recording ID: rec-001");
      expect(entrypoint!.content).toContain("Platform: darwin");
      expect(entrypoint!.content).toContain("Steps: 3");
    });

    it("entrypoint escapes generated block comments for recording metadata", async () => {
      const rec = makeRecording({
        id: 'rec-001 */\nthrow new Error("pwned")\n/*',
        name: 'Login */\nthrow new Error("pwned")\n/* Flow',
        platform: 'darwin */\nthrow new Error("pwned")\n/*',
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      const entrypoint = result.drafts[0].files.find(
        (f) => f.path === "entrypoint.js",
      );
      const headerComment = entrypoint!.content.slice(0, entrypoint!.content.indexOf("import "));

      expect(headerComment).toContain("*\\/");
      expect(headerComment).not.toContain('*/\nthrow new Error("pwned")');
      expect(entrypoint!.content).toContain(`recordingId: ${JSON.stringify(rec.id)}`);
      expect(entrypoint!.content).toContain(`platform: ${JSON.stringify(rec.platform)}`);
      expect(entrypoint!.content).toContain("class FridayDomainError extends Error");
      const executableBody = entrypoint!.content.slice(
        entrypoint!.content.indexOf("const moduleDir"),
      ).replace("import.meta.url", JSON.stringify("file:///tmp/entrypoint.js"));
      expect(() =>
        new Function(executableBody.replace("export default async function execute", "async function execute")),
      ).not.toThrow();
    });

    it("entrypoint fail-closed desktop path throws the generated domain error", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const entrypoint = result.drafts[0].files.find(
        (f) => f.path === "entrypoint.js",
      );
      const executableBody = entrypoint!.content.slice(
        entrypoint!.content.indexOf("const moduleDir"),
      ).replace("import.meta.url", JSON.stringify("file:///tmp/entrypoint.js"));
      const factory = new Function(
        "readFileSync",
        "join",
        "dirname",
        "fileURLToPath",
        `${executableBody.replace("export default async function execute", "async function execute")}
return execute;`,
      );
      const execute = factory(
        () => "[]",
        (...parts: string[]) => parts.join("/"),
        () => "/tmp",
        () => "/tmp/entrypoint.js",
      ) as (input: unknown, ctx: Record<string, unknown>) => Promise<unknown>;

      await expect(execute({}, {})).rejects.toMatchObject({
        name: "FridayDomainError",
        code: "NOT_INITIALIZED",
        httpStatus: 503,
      });
    });

    it("steps JSON contains all recording steps", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const stepsFile = result.drafts[0].files.find(
        (f) => f.path === "recording-steps.json",
      );
      const steps = JSON.parse(stepsFile!.content);
      expect(steps).toHaveLength(3);
      expect(steps[0].action.type).toBe("click");
      expect(steps[1].action.type).toBe("type");
    });

    it("metadata JSON contains recording info without steps", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const metaFile = result.drafts[0].files.find(
        (f) => f.path === "recording-metadata.json",
      );
      const meta = JSON.parse(metaFile!.content);
      expect(meta.id).toBe("rec-001");
      expect(meta.name).toBe("Login Flow");
      expect(meta.platform).toBe("darwin");
      expect(meta.stepCount).toBe(3);
      expect(meta).not.toHaveProperty("steps");
    });
  });

  // ── Conversion — Warnings ──

  describe("convert → warnings", () => {
    it("warns when recording state is not stopped", async () => {
      const rec = makeRecording({ state: "recording" });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("recording"),
        ]),
      );
    });

    it("no state warning for stopped recordings", async () => {
      const rec = makeRecording({ state: "stopped" });
      const result = await converter.convert(makeSource(rec), makeCtx());
      const stateWarnings = result.drafts[0].warnings.filter((w) =>
        w.includes("state is"),
      );
      expect(stateWarnings).toHaveLength(0);
    });

    it("warns when steps had failures during original recording", async () => {
      const rec = makeRecording();
      rec.steps[0].result = { status: "failed", platform: "darwin", errorMessage: "oops" };
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("1 step(s) had failures"),
        ]),
      );
    });

    it("warns when file_operation actions are present", async () => {
      const rec = makeRecording();
      rec.steps.push({
        id: "step-4",
        recordingId: "rec-001",
        stepIndex: 3,
        action: { type: "file_operation", operation: "read", path: "/tmp/file" },
        parameterBindings: {},
        timestamp: "2026-01-01T00:00:04Z",
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("file operations"),
        ]),
      );
    });

    it("warns when params defined but no bindings in steps", async () => {
      const rec = makeRecording();
      // Clear all parameter bindings
      for (const step of rec.steps) {
        step.parameterBindings = {};
      }
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("no steps have parameter bindings"),
        ]),
      );
    });
  });

  // ── Conversion — Report ──

  describe("convert → conversionReport", () => {
    it("includes correct report metadata", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());
      const { conversionReport } = result.drafts[0];

      expect(conversionReport.sourceFormat).toBe("desktop-recording");
      expect(conversionReport.converterId).toBe("desktop-recording");
      expect(conversionReport.convertedAt).toBe("2026-02-25T12:00:00Z");
      expect(conversionReport.sourceRef).toContain("rec-001");
    });

    it("uses source URI when available", async () => {
      const rec = makeRecording();
      const source: FridaySkillConversionSource = {
        contentBase64: toBase64(rec),
        uri: "/path/to/recording.json",
      };
      const result = await converter.convert(source, makeCtx());
      expect(result.drafts[0].conversionReport.sourceRef).toBe(
        "/path/to/recording.json",
      );
    });
  });

  // ── Conversion — Result shape ──

  describe("convert → result", () => {
    it("has correct top-level result shape", async () => {
      const rec = makeRecording();
      const result = await converter.convert(makeSource(rec), makeCtx());

      expect(result.converterId).toBe("desktop-recording");
      expect(result.detectedFormat).toBe("desktop-recording");
      expect(result.drafts).toHaveLength(1);
    });
  });

  // ── Validation Errors ──

  describe("convert → validation errors", () => {
    it("throws for non-recording source", async () => {
      const source: FridaySkillConversionSource = {
        contentBase64: toBase64({ foo: "bar" }),
      };
      await expect(converter.convert(source, makeCtx())).rejects.toThrow(
        "valid desktop recording",
      );
    });

    it("throws for empty steps", async () => {
      const rec = makeRecording({ steps: [] });
      await expect(
        converter.convert(makeSource(rec), makeCtx()),
      ).rejects.toThrow("no steps");
    });

    it("throws for step missing action type", async () => {
      const rec = makeRecording({
        steps: [
          {
            id: "bad",
            recordingId: "rec-001",
            stepIndex: 0,
            action: {},
            parameterBindings: {},
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      });
      await expect(
        converter.convert(makeSource(rec), makeCtx()),
      ).rejects.toThrow("typed action");
    });

    it("throws for missing source content", async () => {
      await expect(
        converter.convert({}, makeCtx()),
      ).rejects.toThrow("valid desktop recording");
    });
  });

  // ── Parameter Type Mapping ──

  describe("parameter type mapping", () => {
    it("maps path parameter to string input type", async () => {
      const rec = makeRecording({
        parameters: {
          filepath: { type: "path", required: true, description: "File path" },
        },
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.inputs[0].type).toBe("string");
    });

    it("maps selector parameter to object input type", async () => {
      const rec = makeRecording({
        parameters: {
          target: { type: "selector", required: true },
        },
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.inputs[0].type).toBe("object");
    });

    it("maps boolean parameter to boolean input type", async () => {
      const rec = makeRecording({
        parameters: {
          flag: { type: "boolean", required: false },
        },
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.inputs[0].type).toBe("boolean");
    });

    it("maps number parameter to number input type", async () => {
      const rec = makeRecording({
        parameters: {
          count: { type: "number", required: false },
        },
      });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.inputs[0].type).toBe("number");
    });
  });

  // ── No Parameters ──

  describe("recording without parameters", () => {
    it("produces manifest with empty inputs", async () => {
      const rec = makeRecording({ parameters: {} });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.inputs).toHaveLength(0);
    });

    it("produces UI schema with empty fields", async () => {
      const rec = makeRecording({ parameters: {} });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].uiSchema.fields).toHaveLength(0);
    });
  });

  // ── Platform Mapping ──

  describe("platform mapping", () => {
    it("maps darwin to darwin OS", async () => {
      const rec = makeRecording({ platform: "darwin" });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.requirements.os).toEqual(["darwin"]);
    });

    it("maps linux to linux OS", async () => {
      const rec = makeRecording({ platform: "linux" });
      const result = await converter.convert(makeSource(rec), makeCtx());
      expect(result.drafts[0].manifest.requirements.os).toEqual(["linux"]);
    });
  });
});
