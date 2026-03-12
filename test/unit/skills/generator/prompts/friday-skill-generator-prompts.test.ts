import { describe, it, expect } from "vitest";

import {
  buildRequirementsPrompt,
  buildManifestPrompt,
  buildCodePrompt,
  buildUiPrompt,
} from "#skills/generator";

import type { FridaySkillGenerationTurn } from "#skills/generator";
import type { SkillManifestV2 } from "#skills";

const STUB_MANIFEST: SkillManifestV2 = {
  schemaVersion: "2.0",
  id: "test-timer",
  name: "Timer",
  description: "A timer skill",
  version: "1.0.0",
  kind: "automation",
  category: "utility",
  author: { name: "Test Author" },
  tags: ["timer"],
  runtime: {
    kind: "node",
    entrypoint: "index.mjs",
    minHubVersion: "0.1.0",
    apiVersion: "1",
    timeoutMsDefault: 30000,
  },
  triggers: { intents: ["start-timer"], phrases: ["start a timer"], channels: [] },
  invocation: {
    userInvocable: true,
    modelInvocable: true,
    priority: 50,
    modes: ["intent"],
  },
  requirements: { bins: [], env: [], config: [], os: ["darwin", "linux"] },
  inputs: [
    { key: "duration", type: "number", required: true, label: "Duration (s)" },
  ],
  outputs: [
    { key: "elapsed", type: "number", description: "Time elapsed in seconds" },
  ],
  permissions: { grants: [], promptOn: [] },
  executionTargets: { allowedSatelliteTypes: [], requiredCapabilities: [] },
};

describe("buildRequirementsPrompt", () => {
  it("returns system and user strings", () => {
    const result = buildRequirementsPrompt(
      "Build a timer skill",
      "",
      [],
      [],
    );
    expect(result.system).toContain("requirements analyzer");
    expect(result.user).toContain("Build a timer skill");
  });

  it("includes spec summary when provided", () => {
    const result = buildRequirementsPrompt(
      "Timer",
      "A countdown timer with configurable duration",
      [],
      [],
    );
    expect(result.user).toContain("A countdown timer with configurable duration");
    expect(result.user).toContain("spec summary");
  });

  it("includes open questions when provided", () => {
    const result = buildRequirementsPrompt(
      "Timer",
      "",
      ["What duration?", "What format?"],
      [],
    );
    expect(result.user).toContain("What duration?");
    expect(result.user).toContain("What format?");
    expect(result.user).toContain("Open questions");
  });

  it("includes recent turns in conversation block", () => {
    const turns: FridaySkillGenerationTurn[] = [
      {
        turnId: "t1",
        sessionId: "s1",
        role: "user",
        content: "I want a timer",
        createdAt: "2025-01-01T00:00:00Z",
      },
      {
        turnId: "t2",
        sessionId: "s1",
        role: "assistant",
        content: "How long should it run?",
        createdAt: "2025-01-01T00:00:01Z",
      },
    ];
    const result = buildRequirementsPrompt("Timer", "", [], turns);
    expect(result.user).toContain("[user]: I want a timer");
    expect(result.user).toContain("[assistant]: How long should it run?");
  });

  it("system prompt enforces JSON-only output", () => {
    const result = buildRequirementsPrompt("Timer", "", [], []);
    expect(result.system).toContain("strict JSON only");
  });

  it("system prompt limits to max 3 questions", () => {
    const result = buildRequirementsPrompt("Timer", "", [], []);
    expect(result.system).toContain("max 3");
  });
});

describe("buildManifestPrompt", () => {
  it("returns system and user strings", () => {
    const spec = { goal: "Timer", inputs: [], outputs: [] };
    const result = buildManifestPrompt(spec);
    expect(result.system).toContain("manifest generator");
    expect(result.user).toContain("Timer");
  });

  it("system prompt enforces JSON-only output", () => {
    const result = buildManifestPrompt({});
    expect(result.system).toContain("JSON only");
  });

  it("system prompt mentions least privilege", () => {
    const result = buildManifestPrompt({});
    expect(result.system).toContain("least privilege");
  });

  it("user prompt includes serialized spec", () => {
    const spec = { goal: "Timer", runtimeKind: "node" };
    const result = buildManifestPrompt(spec);
    expect(result.user).toContain('"runtimeKind"');
    expect(result.user).toContain('"node"');
  });
});

describe("buildCodePrompt", () => {
  it("returns system and user strings", () => {
    const result = buildCodePrompt(STUB_MANIFEST, "node");
    expect(result.system).toContain("code generator");
    expect(result.user).toContain("test-timer");
  });

  it("system prompt describes node executor contract", () => {
    const result = buildCodePrompt(STUB_MANIFEST, "node");
    expect(result.system).toContain("async function execute");
  });

  it("system prompt describes shell executor contract", () => {
    const result = buildCodePrompt(STUB_MANIFEST, "shell");
    expect(result.system).toContain("stdin");
    expect(result.system).toContain("stdout");
  });

  it("user prompt includes runtime kind", () => {
    const result = buildCodePrompt(STUB_MANIFEST, "shell");
    expect(result.user).toContain("runtime: shell");
  });

  it("system prompt enforces JSON array output", () => {
    const result = buildCodePrompt(STUB_MANIFEST, "node");
    expect(result.system).toContain("JSON array");
  });
});

describe("buildUiPrompt", () => {
  it("returns system and user strings", () => {
    const result = buildUiPrompt(STUB_MANIFEST);
    expect(result.system).toContain("UI schema generator");
    expect(result.user).toContain("test-timer");
  });

  it("system prompt enforces input/output key mapping", () => {
    const result = buildUiPrompt(STUB_MANIFEST);
    expect(result.system).toContain("inputKey must map");
    expect(result.system).toContain("outputKey must map");
  });

  it("system prompt requires schemaVersion 1.0", () => {
    const result = buildUiPrompt(STUB_MANIFEST);
    expect(result.system).toContain('schemaVersion');
    expect(result.system).toContain('"1.0"');
  });

  it("system prompt requires run and reset actions", () => {
    const result = buildUiPrompt(STUB_MANIFEST);
    expect(result.system).toContain('"run"');
    expect(result.system).toContain('"reset"');
  });

  it("user prompt includes serialized manifest", () => {
    const result = buildUiPrompt(STUB_MANIFEST);
    expect(result.user).toContain('"duration"');
    expect(result.user).toContain('"elapsed"');
  });
});
