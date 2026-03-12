import { describe, it, expect, vi } from "vitest";
import { createFridayAgentSelfTestService } from "#agent";
import type { CreateFridayAgentSelfTestServiceDeps, FridayAgentExecOutput } from "../../../../src/agent/testing/friday-agent-self-test-service.types.js";
import type { FridayAgentArtifact } from "#agent";

// ─── Helpers ───

function makeDeps(overrides?: Partial<CreateFridayAgentSelfTestServiceDeps>): CreateFridayAgentSelfTestServiceDeps {
  return {
    safeParseFridaySkillManifestV2: vi.fn().mockReturnValue({ success: true }),
    workflowCompiler: { validateSpec: vi.fn().mockReturnValue({ valid: true, errors: [] }) },
    readFile: vi.fn().mockResolvedValue("{}"),
    execCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

function makeArtifact(overrides?: Partial<FridayAgentArtifact>): FridayAgentArtifact {
  return {
    type: "file",
    path: "/tmp/test.js",
    ...overrides,
  };
}

describe("FridayAgentSelfTestService", () => {
  // ─── Generic / no artifacts ───

  it("returns generic pass for empty artifacts list", async () => {
    const svc = createFridayAgentSelfTestService(makeDeps());
    const results = await svc.runTests({ artifacts: [] });

    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe("llm_eval");
    expect(results[0].passed).toBe(true);
  });

  it("returns generic pass for unrecognized artifact types", async () => {
    const svc = createFridayAgentSelfTestService(makeDeps());
    const results = await svc.runTests({
      artifacts: [{ type: "text", path: "/tmp/readme.md" }],
    });

    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe("llm_eval");
    expect(results[0].passed).toBe(true);
  });

  // ─── Code syntax: JavaScript ───

  it("passes JS syntax check when node --check exits 0", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/app.js" })],
    });

    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe("syntax");
    expect(results[0].passed).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('node --check "/tmp/app.js"', undefined);
  });

  it("fails JS syntax check when node --check exits non-zero", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "/tmp/app.js:3: SyntaxError: Unexpected token" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/app.js" })],
    });

    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe("syntax");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors).toHaveLength(1);
    expect(results[0].errors[0].message).toContain("SyntaxError");
    expect(results[0].errors[0].line).toBe(3);
  });

  // ─── Code syntax: TypeScript ───

  it("uses node --check for TypeScript files", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/module.ts" })],
    });

    expect(results[0].strategy).toBe("syntax");
    expect(results[0].passed).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('node --check "/tmp/module.ts"', undefined);
  });

  // ─── Code syntax: Python ───

  it("uses python3 compile for Python files", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/script.py" })],
    });

    expect(results[0].strategy).toBe("syntax");
    expect(results[0].passed).toBe(true);
    expect(execCommand).toHaveBeenCalledWith(
      expect.stringContaining("py_compile"),
      undefined,
    );
  });

  it("fails Python syntax check on compile error", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 1, stdout: "", stderr: "SyntaxError: invalid syntax" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/script.py" })],
    });

    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("SyntaxError");
  });

  // ─── Code syntax: Shell ───

  it("uses bash -n for shell files", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/deploy.sh" })],
    });

    expect(results[0].strategy).toBe("syntax");
    expect(results[0].passed).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('bash -n "/tmp/deploy.sh"', undefined);
  });

  it("fails shell syntax check on error", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 2, stdout: "", stderr: "/tmp/deploy.sh: line 10: syntax error" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/deploy.sh" })],
    });

    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("syntax error");
  });

  // ─── Code with no path ───

  it("returns error when code artifact has no path", async () => {
    const svc = createFridayAgentSelfTestService(makeDeps());

    const results = await svc.runTests({
      artifacts: [{ type: "file", path: undefined }],
    });

    // Falls through to generic since no extension
    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe("llm_eval");
  });

  // ─── Skill manifest validation ───

  it("passes skill manifest when schema validates", async () => {
    const safeParse = vi.fn().mockReturnValue({ success: true });
    const readFile = vi.fn().mockResolvedValue('{"schemaVersion":"2.0","id":"test"}');
    const svc = createFridayAgentSelfTestService(makeDeps({ safeParseFridaySkillManifestV2: safeParse, readFile }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "skill", path: "/tmp/manifest.json" })],
    });

    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe("manifest");
    expect(results[0].passed).toBe(true);
    expect(safeParse).toHaveBeenCalled();
  });

  it("fails skill manifest when schema rejects", async () => {
    const safeParse = vi.fn().mockReturnValue({
      success: false,
      error: {
        issues: [
          { message: "Required", path: ["name"] },
          { message: "Expected string, received number", path: ["version"] },
        ],
      },
    });
    const readFile = vi.fn().mockResolvedValue("{}");
    const svc = createFridayAgentSelfTestService(makeDeps({ safeParseFridaySkillManifestV2: safeParse, readFile }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "skill", path: "/tmp/manifest.json" })],
    });

    expect(results[0].strategy).toBe("manifest");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors).toHaveLength(2);
    expect(results[0].errors[0].message).toContain("name");
    expect(results[0].errors[1].message).toContain("version");
  });

  it("detects skill artifact by skillId field", async () => {
    const safeParse = vi.fn().mockReturnValue({ success: true });
    const readFile = vi.fn().mockResolvedValue("{}");
    const svc = createFridayAgentSelfTestService(makeDeps({ safeParseFridaySkillManifestV2: safeParse, readFile }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "file", skillId: "my-skill", path: "/tmp/manifest.json" })],
    });

    expect(results[0].strategy).toBe("manifest");
  });

  it("fails skill manifest when file cannot be read", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const svc = createFridayAgentSelfTestService(makeDeps({ readFile }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "skill", path: "/tmp/missing.json" })],
    });

    expect(results[0].strategy).toBe("manifest");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("ENOENT");
  });

  it("fails skill manifest when path is missing", async () => {
    const svc = createFridayAgentSelfTestService(makeDeps());

    const results = await svc.runTests({
      artifacts: [{ type: "skill" }],
    });

    expect(results[0].strategy).toBe("manifest");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("No file path");
  });

  // ─── Workflow graph validation ───

  it("passes workflow when compiler validates", async () => {
    const validateSpec = vi.fn().mockReturnValue({ valid: true, errors: [] });
    const readFile = vi.fn().mockResolvedValue('{"schemaVersion":"1.0"}');
    const svc = createFridayAgentSelfTestService(
      makeDeps({ workflowCompiler: { validateSpec }, readFile }),
    );

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "workflow", path: "/tmp/workflow.json" })],
    });

    expect(results[0].strategy).toBe("compile");
    expect(results[0].passed).toBe(true);
  });

  it("fails workflow when compiler rejects", async () => {
    const validateSpec = vi.fn().mockReturnValue({
      valid: false,
      errors: [
        { code: "WORKFLOW_EMPTY_GRAPH", message: "Graph must contain at least one node" },
      ],
    });
    const readFile = vi.fn().mockResolvedValue("{}");
    const svc = createFridayAgentSelfTestService(
      makeDeps({ workflowCompiler: { validateSpec }, readFile }),
    );

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "workflow", path: "/tmp/workflow.json" })],
    });

    expect(results[0].strategy).toBe("compile");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("at least one node");
  });

  it("detects workflow artifact by workflowId field", async () => {
    const validateSpec = vi.fn().mockReturnValue({ valid: true, errors: [] });
    const readFile = vi.fn().mockResolvedValue("{}");
    const svc = createFridayAgentSelfTestService(
      makeDeps({ workflowCompiler: { validateSpec }, readFile }),
    );

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "file", workflowId: "wf-1", path: "/tmp/wf.json" })],
    });

    expect(results[0].strategy).toBe("compile");
  });

  it("fails workflow when file cannot be read", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const svc = createFridayAgentSelfTestService(makeDeps({ readFile }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "workflow", path: "/tmp/missing.json" })],
    });

    expect(results[0].strategy).toBe("compile");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("ENOENT");
  });

  it("fails workflow when path is missing", async () => {
    const svc = createFridayAgentSelfTestService(makeDeps());

    const results = await svc.runTests({
      artifacts: [{ type: "workflow" }],
    });

    expect(results[0].strategy).toBe("compile");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("No file path");
  });

  it("handles compiler throwing an exception", async () => {
    const validateSpec = vi.fn().mockImplementation(() => {
      throw new Error("Compilation explosion");
    });
    const readFile = vi.fn().mockResolvedValue("{}");
    const svc = createFridayAgentSelfTestService(
      makeDeps({ workflowCompiler: { validateSpec }, readFile }),
    );

    const results = await svc.runTests({
      artifacts: [makeArtifact({ type: "workflow", path: "/tmp/wf.json" })],
    });

    expect(results[0].strategy).toBe("compile");
    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("Compilation explosion");
  });

  // ─── Multiple artifacts ───

  it("tests multiple artifacts independently", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "syntax error" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [
        makeArtifact({ path: "/tmp/good.js" }),
        makeArtifact({ path: "/tmp/bad.sh" }),
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });

  // ─── Workdir propagation ───

  it("passes workdir to exec command", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/app.js" })],
      workdir: "/project",
    });

    expect(execCommand).toHaveBeenCalledWith('node --check "/tmp/app.js"', "/project");
  });

  // ─── Duration tracking ───

  it("records durationMs for each test result", async () => {
    const svc = createFridayAgentSelfTestService(makeDeps());

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/app.js" })],
    });

    expect(typeof results[0].durationMs).toBe("number");
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Exec command throws ───

  it("handles exec command throwing an error", async () => {
    const execCommand = vi.fn<(cmd: string, wd?: string) => Promise<FridayAgentExecOutput>>()
      .mockRejectedValue(new Error("spawn failed"));
    const svc = createFridayAgentSelfTestService(makeDeps({ execCommand }));

    const results = await svc.runTests({
      artifacts: [makeArtifact({ path: "/tmp/app.js" })],
    });

    expect(results[0].passed).toBe(false);
    expect(results[0].errors[0].message).toContain("spawn failed");
  });
});
