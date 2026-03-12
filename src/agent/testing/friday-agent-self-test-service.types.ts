import type { FridayAgentArtifact, FridayAgentTestResult } from "../model/friday-agent.types.js";
import type { FridayWorkflowCompiler } from "#workflows";

// ─── Service interface ───

export interface FridayAgentSelfTestService {
  /** Run test strategies against agent output artifacts. */
  runTests(params: FridayAgentSelfTestParams): Promise<FridayAgentTestResult[]>;
}

// ─── Params ───

export interface FridayAgentSelfTestParams {
  /** Artifacts produced by the agent run. */
  artifacts: FridayAgentArtifact[];
  /** Working directory for running syntax checks. */
  workdir?: string;
}

// ─── Artifact classification ───

export type FridayAgentArtifactKind =
  | "code_ts"
  | "code_js"
  | "code_py"
  | "code_sh"
  | "skill_manifest"
  | "workflow_graph"
  | "generic";

// ─── Factory deps ───

export interface CreateFridayAgentSelfTestServiceDeps {
  /** Validates skill manifests via safe parse. */
  safeParseFridaySkillManifestV2: (input: unknown) => { success: boolean; error?: { issues: Array<{ message: string; path: Array<string | number> }> } };
  /** Compiles and validates workflow specs. */
  workflowCompiler: Pick<FridayWorkflowCompiler, "validateSpec">;
  /** Reads a file by path. Returns its content as string. */
  readFile: (path: string) => Promise<string>;
  /** Runs a shell command, returns { exitCode, stdout, stderr }. */
  execCommand: (command: string, workdir?: string) => Promise<FridayAgentExecOutput>;
}

export interface FridayAgentExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}
