import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES,
  FRIDAY_AGENT_EXEC_TIMEOUT_MS,
} from "../friday-agent.constants.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  readBooleanParam,
  readNumberParam,
  readRecordParam,
  readStringParam,
  textResult,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";
import { getApprovalRequiredReasonForExecCommand } from "../runtime/friday-agent-tool-risk.js";

// ─── Options ───

export interface CreateFridayAgentExecToolOptions {
  defaultWorkdir?: string;
  /** Root directory for workspace sandboxing. Commands accessing outside this path are rejected. */
  workspaceRoot?: string;
  /** When false (default), reject commands containing shell metacharacters (;|&`$). */
  allowShell?: boolean;
  /** Injectable spawn implementation for testing. Defaults to Node's `child_process.spawn`. */
  spawnImpl?: typeof spawn;
  /** Injectable realpathSync implementation for testing. Defaults to `fs.realpathSync`. */
  realpathSyncImpl?: typeof fs.realpathSync;
}

// ─── Shell metacharacter pattern ───
// Blocks shell metacharacters plus Unicode whitespace and control characters
// that could be used to bypass argument splitting or inject hidden separators.

const SHELL_META_RE = /[;|&`$(){}\n\r<>#!~]/;
const UNICODE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u00A0\u1680\u2000-\u200F\u2028\u2029\u202A-\u202F\u205F\u2060\u3000\uFEFF\uFFF0-\uFFFF]/;
// ─── Factory ───

export function createFridayAgentExecTool(
  options?: CreateFridayAgentExecToolOptions,
): FridayAgentToolDefinition {
  const defaultWorkdir = options?.defaultWorkdir ?? process.cwd();
  const workspaceRoot = options?.workspaceRoot ?? defaultWorkdir;
  const allowShell = options?.allowShell ?? false;
  const spawnFn = options?.spawnImpl ?? spawn;
  const realpathSyncFn = options?.realpathSyncImpl ?? fs.realpathSync;

  return {
    name: "exec",
    description:
      "Execute shell commands. Use background=true for long-running commands. " +
      "Returns stdout+stderr combined output.",
    parameters: {
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        workdir: { type: "string", description: "Working directory (defaults to cwd)" },
        env: { type: "object", description: "Extra environment variables" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds" },
        background: { type: "boolean", description: "Run in background (return immediately)" },
      },
      required: ["command"],
    },
    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const command = readStringParam(args, "command", { required: true });
      const workdir = readStringParam(args, "workdir") ?? defaultWorkdir;
      const env = readRecordParam(args, "env");
      const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true }) ?? FRIDAY_AGENT_EXEC_TIMEOUT_MS;
      const background = readBooleanParam(args, "background") ?? false;

      // Security: reject shell metacharacters when allowShell is false
      if (!allowShell && SHELL_META_RE.test(command)) {
        return errorResult(
          "Command contains shell metacharacters (;|&`$(){}) which are not allowed. " +
          "Use simple commands without shell piping or chaining.",
        );
      }

      // Security: reject Unicode control/whitespace characters that could bypass
      // argument parsing or hide malicious content in invisible characters
      if (!allowShell && UNICODE_CONTROL_RE.test(command)) {
        return errorResult(
          "Command contains Unicode control or non-standard whitespace characters which are not allowed. " +
          "Use only ASCII printable characters and standard spaces.",
        );
      }

      const approvalReason = getApprovalRequiredReasonForExecCommand(command);
      if (approvalReason) {
        return errorResult(`Approval required before execution. ${approvalReason}`);
      }

      // Security: ensure workdir is within the workspace root (resolve symlinks)
      let resolvedWorkdir: string;
      try {
        resolvedWorkdir = realpathSyncFn(workdir) as string;
      } catch (err) {
        console.warn("[friday][agent-exec-tool] workdir resolve failed:", err instanceof Error ? err.message : String(err));
        return errorResult(
          `Working directory "${workdir}" does not exist or is not accessible.`,
        );
      }
      let resolvedRoot: string;
      try {
        resolvedRoot = realpathSyncFn(workspaceRoot) as string;
      } catch (err) {
        console.warn("[friday][agent-exec-tool] workspace root resolve failed:", err instanceof Error ? err.message : String(err));
        resolvedRoot = path.resolve(workspaceRoot);
      }
      if (!resolvedWorkdir.startsWith(resolvedRoot + path.sep) && resolvedWorkdir !== resolvedRoot) {
        return errorResult(
          `Working directory "${workdir}" is outside the allowed workspace root "${workspaceRoot}".`,
        );
      }

      const mergedEnv = env ? { ...process.env, ...env } : process.env;

      return new Promise<FridayAgentToolResult>((resolve) => {
        // When allowShell is false, avoid shell: true entirely to prevent shell
        // interpretation of metacharacters, redirections, and path escapes.
        let proc: ChildProcess;
        if (allowShell) {
          proc = spawnFn(command, [], {
            shell: true,
            cwd: resolvedWorkdir,
            env: mergedEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } else {
          // Split command into program + args without shell interpretation
          const parts = command.trim().split(/\s+/);
          const program = parts[0]!;
          const spawnArgs = parts.slice(1);
          proc = spawnFn(program, spawnArgs, {
            shell: false,
            cwd: resolvedWorkdir,
            env: mergedEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });
        }

        let output = "";
        let outputBytes = 0;
        let killed = false;
        let timedOut = false;

        const appendOutput = (chunk: Buffer) => {
          if (outputBytes >= FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES) {
            return;
          }
          const text = chunk.toString("utf8");
          output += text;
          outputBytes += chunk.byteLength;
        };

        proc.stdout?.on("data", appendOutput);
        proc.stderr?.on("data", appendOutput);

        // Timeout handling
        const timer = setTimeout(() => {
          timedOut = true;
          killed = true;
          proc.kill("SIGTERM");
          // Force kill after 5 seconds
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          }, 5_000);
        }, Math.max(1, timeoutMs));

        // Abort signal handling
        const onAbort = () => {
          if (!killed) {
            killed = true;
            proc.kill("SIGTERM");
          }
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        // Background mode — return immediately
        if (background) {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(
            textResult(
              `Command started in background (pid ${String(proc.pid ?? "unknown")}). ` +
              "Output will not be captured.",
            ),
          );
          return;
        }

        proc.on("close", (code: number | null) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);

          const truncated = truncateOutput(output, FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES);
          const exitCode = code ?? (killed ? 137 : 1);

          if (timedOut) {
            resolve(
              errorResult(
                `Command timed out after ${String(timeoutMs)}ms (exit code ${String(exitCode)}).\n${truncated}`,
              ),
            );
            return;
          }

          if (exitCode !== 0) {
            resolve(
              errorResult(
                `Command failed (exit code ${String(exitCode)}).\n${truncated}`,
              ),
            );
            return;
          }

          resolve(textResult(truncated || "(no output)"));
        });

        proc.on("error", (err: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(errorResult(`Command error: ${err.message}`));
        });
      });
    },
  };
}
