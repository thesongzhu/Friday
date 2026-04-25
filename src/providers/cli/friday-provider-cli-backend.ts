import { execFile as execFileCb, spawn } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

import type {
  FridayCliSessionStatus,
  FridayProviderCliBackendId,
  FridayProviderCliConfig,
} from "../model/friday-provider.types.js";

const execFile = promisify(execFileCb);
const CLI_OUTPUT_MAX_BYTES = 1_048_576;
const CLI_COMPLETION_TIMEOUT_MS = 300_000;

interface FridayCliBackendSpec {
  id: FridayProviderCliBackendId;
  binaryNames: readonly string[];
  versionArgs: readonly string[];
  statusArgs?: readonly string[];
}

const CLI_BACKEND_SPECS: Record<FridayProviderCliBackendId, FridayCliBackendSpec> = {
  "codex-cli": {
    id: "codex-cli",
    binaryNames: ["codex"],
    versionArgs: ["--version"],
    statusArgs: ["login", "status"],
  },
  "claude-cli": {
    id: "claude-cli",
    binaryNames: ["claude"],
    versionArgs: ["--version"],
    statusArgs: ["auth", "status"],
  },
};

function sanitizeEnv(extraAllowlist?: readonly string[]): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    ...(extraAllowlist ?? []),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (allowed.has(key) && process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function truncateOutput(streamName: "stdout" | "stderr", value: string | Buffer, maxBytes: number = CLI_OUTPUT_MAX_BYTES): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.length <= maxBytes) {
    return buffer.toString("utf8");
  }
  const prefix = buffer.subarray(0, maxBytes).toString("utf8");
  const separator = prefix.length === 0 || prefix.endsWith("\n") ? "" : "\n";
  return `${prefix}${separator}[friday] ${streamName} truncated after ${String(maxBytes)} bytes; discarded ${String(buffer.length - maxBytes)} bytes.`;
}

function createBoundedOutputCollector(streamName: "stdout" | "stderr", maxBytes: number = CLI_OUTPUT_MAX_BYTES) {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let discardedBytes = 0;
  return {
    append(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = maxBytes - capturedBytes;
      if (remainingBytes > 0) {
        const captured = buffer.subarray(0, remainingBytes);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
      if (buffer.length > remainingBytes) {
        discardedBytes += buffer.length - Math.max(remainingBytes, 0);
      }
    },
    toString(): string {
      const output = Buffer.concat(chunks).toString("utf8");
      if (discardedBytes === 0) return output;
      const separator = output.length === 0 || output.endsWith("\n") ? "" : "\n";
      return `${output}${separator}[friday] ${streamName} truncated after ${String(maxBytes)} bytes; discarded ${String(discardedBytes)} bytes.`;
    },
  };
}

async function readFileBounded(path: string, streamName: "stdout" | "stderr", maxBytes: number = CLI_OUTPUT_MAX_BYTES): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return truncateOutput(streamName, buffer.subarray(0, bytesRead), maxBytes);
  } finally {
    await file.close();
  }
}

async function runExecFile(
  binary: string,
  args: readonly string[],
  input?: string,
  envAllowlist?: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFile(binary, [...args], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: CLI_OUTPUT_MAX_BYTES,
      env: sanitizeEnv(envAllowlist),
      ...(input !== undefined ? { input } : {}),
    });
    return {
      stdout: truncateOutput("stdout", result.stdout ?? ""),
      stderr: truncateOutput("stderr", result.stderr ?? ""),
      exitCode: 0,
    };
  } catch (error) {
    const err = error as Error & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    if (err.code === "ENOENT") {
      throw new FridayDomainError(
        "PROVIDER_UNREACHABLE",
        `CLI binary "${binary}" not found`,
        { httpStatus: 422 },
      );
    }
    return {
      stdout: truncateOutput("stdout", err.stdout ?? ""),
      stderr: truncateOutput("stderr", err.stderr ?? err.message),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

async function runSpawned(
  binary: string,
  args: readonly string[],
  input: string,
  envAllowlist?: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: sanitizeEnv(envAllowlist),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = createBoundedOutputCollector("stdout");
    const stderr = createBoundedOutputCollector("stderr");
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      stderr.append(`CLI backend timed out after ${String(CLI_COMPLETION_TIMEOUT_MS)}ms`);
      child.kill("SIGKILL");
    }, CLI_COMPLETION_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.stdin.on("error", (error) => {
      stderr.append(error.message);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: timedOut ? 124 : code ?? 1,
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function getCliBackendSpec(backendId: FridayProviderCliBackendId): FridayCliBackendSpec {
  return CLI_BACKEND_SPECS[backendId];
}

function resolveBinaryPath(cliConfig: FridayProviderCliConfig): string {
  if (cliConfig.binaryPath && cliConfig.binaryPath.trim().length > 0) {
    return cliConfig.binaryPath;
  }
  const spec = getCliBackendSpec(cliConfig.backendId);
  return spec.binaryNames[0]!;
}

function parseClaudeStatus(stdout: string): Pick<FridayCliSessionStatus, "loggedIn" | "account" | "message"> {
  try {
    const parsed = JSON.parse(stdout) as {
      loggedIn?: boolean;
      email?: string;
      orgId?: string;
      orgName?: string | null;
      subscriptionType?: string;
      authMethod?: string;
    };
    return {
      loggedIn: parsed.loggedIn === true,
      account: {
        email: parsed.email,
        orgId: parsed.orgId,
        orgName: parsed.orgName ?? undefined,
        subscriptionType: parsed.subscriptionType,
        authMethod: parsed.authMethod,
      },
    };
  } catch {
    return {
      message: "Claude CLI auth status output could not be parsed",
    };
  }
}

function parseCodexStatus(stdout: string, stderr: string): Pick<FridayCliSessionStatus, "loggedIn" | "message"> {
  const text = `${stdout}\n${stderr}`.trim();
  if (text.length === 0) {
    return { message: "Codex CLI did not emit login status details in this environment" };
  }
  const lowered = text.toLowerCase();
  if (lowered.includes("logged in") || lowered.includes("authenticated")) {
    return { loggedIn: true };
  }
  if (lowered.includes("not logged in") || lowered.includes("login required")) {
    return { loggedIn: false };
  }
  return { message: text.slice(0, 240) };
}

export async function probeFridayCliSession(input: {
  cliConfig: FridayProviderCliConfig;
  nowIso: () => string;
}): Promise<FridayCliSessionStatus> {
  const checkedAt = input.nowIso();
  const spec = getCliBackendSpec(input.cliConfig.backendId);
  const binaryPath = resolveBinaryPath(input.cliConfig);

  try {
    const versionResult = await runExecFile(
      binaryPath,
      spec.versionArgs,
      undefined,
      input.cliConfig.envAllowlist,
    );
    const version = versionResult.stdout.trim() || versionResult.stderr.trim() || undefined;

    if (!spec.statusArgs) {
      return {
        backendId: spec.id,
        binaryPath,
        status: "status_unknown",
        version,
        checkedAt,
        message: "No auth status probe is defined for this CLI backend",
      };
    }

    const statusResult = await runExecFile(
      binaryPath,
      spec.statusArgs,
      undefined,
      input.cliConfig.envAllowlist,
    );

    if (spec.id === "claude-cli") {
      const parsed = parseClaudeStatus(statusResult.stdout);
      return {
        backendId: spec.id,
        binaryPath,
        status: parsed.loggedIn === true
          ? "healthy"
          : parsed.loggedIn === false
            ? "missing"
            : "status_unknown",
        version,
        loggedIn: parsed.loggedIn,
        checkedAt,
        message: parsed.message,
        account: parsed.account,
      };
    }

    if (spec.id === "codex-cli") {
      const parsed = parseCodexStatus(statusResult.stdout, statusResult.stderr);
      return {
        backendId: spec.id,
        binaryPath,
        status: parsed.loggedIn === true
          ? "healthy"
          : parsed.loggedIn === false
            ? "missing"
            : "status_unknown",
        version,
        loggedIn: parsed.loggedIn,
        checkedAt,
        message: parsed.message,
      };
    }

    const raw = `${statusResult.stdout}\n${statusResult.stderr}`.trim();
    return {
      backendId: spec.id,
      binaryPath,
      status: raw.length > 0 ? "status_unknown" : "missing",
      version,
      checkedAt,
      message: raw || "CLI backend is installed but login status could not be determined",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      backendId: spec.id,
      binaryPath,
      status: "missing",
      checkedAt,
      message,
    };
  }
}

function buildCliPrompt(systemPrompt: string, conversation: string): string {
  return [
    "System instructions:",
    systemPrompt.trim(),
    "",
    "Conversation:",
    conversation.trim(),
    "",
    "Respond directly to the user. Do not describe hidden tools or internal routing.",
  ].join("\n");
}

export async function runFridayCliBackendTextCompletion(input: {
  cliConfig: FridayProviderCliConfig;
  systemPrompt: string;
  conversation: string;
  model?: string;
}): Promise<string> {
  const binaryPath = resolveBinaryPath(input.cliConfig);
  const prompt = buildCliPrompt(input.systemPrompt, input.conversation);

  switch (input.cliConfig.backendId) {
    case "claude-cli": {
      const args = [
        "-p",
        "--output-format",
        "text",
        "--permission-mode",
        "default",
        "--tools",
        "",
        ...(input.model ? ["--model", input.model] : []),
      ];
      const result = await runSpawned(binaryPath, args, prompt, input.cliConfig.envAllowlist);
      if (result.exitCode !== 0) {
        throw new FridayDomainError(
          "LLM_ERROR",
          `Claude CLI backend failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
          { httpStatus: 502 },
        );
      }
      return result.stdout.trim();
    }
    case "codex-cli": {
      const tempDir = await mkdtemp(join(tmpdir(), "friday-codex-cli-"));
      const outputPath = join(tempDir, "last-message.txt");
      try {
        const args = [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--output-last-message",
          outputPath,
          ...(input.model ? ["--model", input.model] : []),
          "-",
        ];
        const result = await runSpawned(binaryPath, args, prompt, input.cliConfig.envAllowlist);
        if (result.exitCode !== 0) {
          throw new FridayDomainError(
            "LLM_ERROR",
            `Codex CLI backend failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
            { httpStatus: 502 },
          );
        }
        const output = await readFileBounded(outputPath, "stdout").catch(() => result.stdout);
        return output.trim();
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
