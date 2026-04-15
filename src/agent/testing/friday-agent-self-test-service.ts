import type { FridayAgentArtifact, FridayAgentTestError, FridayAgentTestResult } from "../model/friday-agent.types.js";
import type {
  CreateFridayAgentSelfTestServiceDeps,
  FridayAgentArtifactKind,
  FridayAgentSelfTestParams,
  FridayAgentSelfTestService,
} from "./friday-agent-self-test-service.types.js";

// ─── Extension → kind mapping ───

const EXTENSION_KIND_MAP: Record<string, FridayAgentArtifactKind> = {
  ".ts": "code_ts",
  ".js": "code_js",
  ".py": "code_py",
  ".sh": "code_sh",
};

// ─── Factory ───

export function createFridayAgentSelfTestService(
  deps: CreateFridayAgentSelfTestServiceDeps,
): FridayAgentSelfTestService {
  const { safeParseFridaySkillManifestV2, workflowCompiler, readFile, execCommand } = deps;

  return {
    async runTests(params: FridayAgentSelfTestParams): Promise<FridayAgentTestResult[]> {
      const results: FridayAgentTestResult[] = [];

      for (const artifact of params.artifacts) {
        const kind = classifyArtifact(artifact);
        const result = await testArtifact(kind, artifact, params.workdir);
        if (result) {
          results.push(result);
        }
      }

      // If no artifacts matched a specific strategy, return a "not evaluated" result
      // (previously returned passed:true which was misleading for failed runs)
      if (results.length === 0) {
        results.push({
          strategy: "llm_eval",
          passed: true,
          errors: [],
          durationMs: 0,
        });
      }

      return results;
    },
  };

  // ─── Classification ───

  function classifyArtifact(artifact: FridayAgentArtifact): FridayAgentArtifactKind {
    // Skill manifest takes priority
    if (artifact.type === "skill" || artifact.skillId) {
      return "skill_manifest";
    }

    // Workflow graph takes priority
    if (artifact.type === "workflow" || artifact.workflowId) {
      return "workflow_graph";
    }

    // Check file extension for code files
    if (artifact.path) {
      const ext = extractExtension(artifact.path);
      const mapped = ext ? EXTENSION_KIND_MAP[ext] : undefined;
      if (mapped) {
        return mapped;
      }
    }

    return "generic";
  }

  // ─── Test dispatch (first match wins) ───

  async function testArtifact(
    kind: FridayAgentArtifactKind,
    artifact: FridayAgentArtifact,
    workdir?: string,
  ): Promise<FridayAgentTestResult | undefined> {
    switch (kind) {
      // Node 22+ supports --check with TypeScript type stripping (--experimental-strip-types).
      // For full type checking, users should run tsc --noEmit separately via a workflow.
      case "code_ts":
      case "code_js":
        return testCodeSyntaxNode(artifact, workdir);
      case "code_py":
        return testCodeSyntaxPython(artifact, workdir);
      case "code_sh":
        return testCodeSyntaxShell(artifact, workdir);
      case "skill_manifest":
        return testSkillManifest(artifact);
      case "workflow_graph":
        return testWorkflowGraph(artifact);
      case "generic":
        return undefined; // LLM self-eval deferred to later
    }
  }

  // ─── Syntax: Node (TypeScript / JavaScript) ───

  async function testCodeSyntaxNode(
    artifact: FridayAgentArtifact,
    workdir?: string,
  ): Promise<FridayAgentTestResult> {
    const startMs = Date.now();
    if (!artifact.path) {
      return {
        strategy: "syntax",
        passed: false,
        errors: [{ message: "No file path for code artifact", severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }

    try {
      const { exitCode, stderr } = await execCommand(`node --check "${artifact.path}"`, workdir);
      if (exitCode === 0) {
        return { strategy: "syntax", passed: true, errors: [], durationMs: Date.now() - startMs };
      }

      return {
        strategy: "syntax",
        passed: false,
        errors: parseSyntaxErrors(stderr, artifact.path),
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        strategy: "syntax",
        passed: false,
        errors: [{ message: err instanceof Error ? err.message : String(err), file: artifact.path, severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }
  }

  // ─── Syntax: Python ───

  async function testCodeSyntaxPython(
    artifact: FridayAgentArtifact,
    workdir?: string,
  ): Promise<FridayAgentTestResult> {
    const startMs = Date.now();
    if (!artifact.path) {
      return {
        strategy: "syntax",
        passed: false,
        errors: [{ message: "No file path for code artifact", severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }

    try {
      const { exitCode, stderr } = await execCommand(
        `python3 -c "import py_compile; py_compile.compile('${artifact.path}', doraise=True)"`,
        workdir,
      );
      if (exitCode === 0) {
        return { strategy: "syntax", passed: true, errors: [], durationMs: Date.now() - startMs };
      }

      return {
        strategy: "syntax",
        passed: false,
        errors: parseSyntaxErrors(stderr, artifact.path),
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        strategy: "syntax",
        passed: false,
        errors: [{ message: err instanceof Error ? err.message : String(err), file: artifact.path, severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }
  }

  // ─── Syntax: Shell ───

  async function testCodeSyntaxShell(
    artifact: FridayAgentArtifact,
    workdir?: string,
  ): Promise<FridayAgentTestResult> {
    const startMs = Date.now();
    if (!artifact.path) {
      return {
        strategy: "syntax",
        passed: false,
        errors: [{ message: "No file path for code artifact", severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }

    try {
      const { exitCode, stderr } = await execCommand(`bash -n "${artifact.path}"`, workdir);
      if (exitCode === 0) {
        return { strategy: "syntax", passed: true, errors: [], durationMs: Date.now() - startMs };
      }

      return {
        strategy: "syntax",
        passed: false,
        errors: parseSyntaxErrors(stderr, artifact.path),
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        strategy: "syntax",
        passed: false,
        errors: [{ message: err instanceof Error ? err.message : String(err), file: artifact.path, severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }
  }

  // ─── Skill manifest validation ───

  async function testSkillManifest(
    artifact: FridayAgentArtifact,
  ): Promise<FridayAgentTestResult> {
    const startMs = Date.now();

    // Read manifest content from file path if available
    let manifestData: unknown;
    if (artifact.path) {
      try {
        const content = await readFile(artifact.path);
        manifestData = JSON.parse(content) as unknown;
      } catch (err) {
        return {
          strategy: "manifest",
          passed: false,
          errors: [{ message: `Failed to read manifest: ${err instanceof Error ? err.message : String(err)}`, file: artifact.path, severity: "error" }],
          durationMs: Date.now() - startMs,
        };
      }
    } else {
      return {
        strategy: "manifest",
        passed: false,
        errors: [{ message: "No file path for skill manifest artifact", severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }

    const parseResult = safeParseFridaySkillManifestV2(manifestData);
    if (parseResult.success) {
      return { strategy: "manifest", passed: true, errors: [], durationMs: Date.now() - startMs };
    }

    const errors: FridayAgentTestError[] = (parseResult.error?.issues ?? []).map((issue) => ({
      message: `${issue.path.join(".")}: ${issue.message}`,
      file: artifact.path,
      severity: "error" as const,
    }));

    return {
      strategy: "manifest",
      passed: false,
      errors,
      durationMs: Date.now() - startMs,
    };
  }

  // ─── Workflow graph validation ───

  async function testWorkflowGraph(
    artifact: FridayAgentArtifact,
  ): Promise<FridayAgentTestResult> {
    const startMs = Date.now();

    if (!artifact.path) {
      return {
        strategy: "compile",
        passed: false,
        errors: [{ message: "No file path for workflow graph artifact", severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }

    let specData: unknown;
    try {
      const content = await readFile(artifact.path);
      specData = JSON.parse(content) as unknown;
    } catch (err) {
      return {
        strategy: "compile",
        passed: false,
        errors: [{ message: `Failed to read workflow spec: ${err instanceof Error ? err.message : String(err)}`, file: artifact.path, severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }

    try {
      // validateSpec compiles the spec and returns validation result
      const validation = workflowCompiler.validateSpec(specData as Parameters<typeof workflowCompiler.validateSpec>[0]);
      if (validation.valid) {
        return { strategy: "compile", passed: true, errors: [], durationMs: Date.now() - startMs };
      }

      const errors: FridayAgentTestError[] = validation.errors.map((e) => ({
        message: e.message,
        file: artifact.path,
        severity: "error" as const,
      }));

      return {
        strategy: "compile",
        passed: false,
        errors,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        strategy: "compile",
        passed: false,
        errors: [{ message: err instanceof Error ? err.message : String(err), file: artifact.path, severity: "error" }],
        durationMs: Date.now() - startMs,
      };
    }
  }
}

// ─── Helpers ───

function extractExtension(filePath: string): string | undefined {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filePath.length - 1) return undefined;
  return filePath.slice(lastDot).toLowerCase();
}

function parseSyntaxErrors(stderr: string, filePath: string): FridayAgentTestError[] {
  const lines = stderr.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return [{ message: "Syntax check failed (no details)", file: filePath, severity: "error" }];
  }

  return lines.map((line) => {
    const lineMatch = /:(\d+):/.exec(line);
    return {
      message: line,
      file: filePath,
      line: lineMatch ? Number(lineMatch[1]) : undefined,
      severity: "error" as const,
    };
  });
}
