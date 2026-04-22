import type {
  CreateFridaySkillExecutorDeps,
  FridaySkillAiHelperContext,
  FridaySkillExecuteHandle,
  FridaySkillExecuteRequest,
  FridaySkillExecuteResult,
  FridaySkillExecutor,
} from "./friday-skill-executor.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillRunSnapshot } from "#ledger";
import { FridayDomainError } from "#errors";
import {
  FRIDAY_ANTHROPIC_OAUTH_HEADERS,
  FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX,
  isFridayAnthropicBearerAuthMode,
} from "#providers";
import { createFridayShellExecutor } from "./friday-shell-executor.js";
import {
  canRunFridayBundledSystemNodeSkillWithoutGate,
  createFridayNodeExecutor,
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  getFridayUnisolatedNodeSkillsDisabledMessage,
  isFridayUnisolatedNodeSkillsEnabled,
} from "./friday-node-executor.js";
import { evaluateFridaySkillExecutionReadiness } from "./friday-skill-execution-readiness.js";
import {
  getFridayPythonRuntimeUnavailableMessage,
  resolveFridayPythonCommand,
} from "./friday-runtime-probe.js";
import { createFridaySkillReadonlyRuntimeContext } from "./friday-skill-runtime-bridge.js";
import { compileFridaySkillSchemas } from "../validation/friday-skill-schema-compiler.js";
import { resolve } from "node:path";

function defaultTenantContext(request: FridaySkillExecuteRequest) {
  return request.tenantContext ?? {
    hubId: "default",
    userId: request.userId,
    channelKind: request.channel,
  };
}

async function runProviderInference(params: {
  providerService: NonNullable<CreateFridaySkillExecutorDeps["providerService"]>;
  tenantContext: ReturnType<typeof defaultTenantContext>;
  prompt: string;
  requestedModel?: string;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  api: string;
  baseUrl: string;
  attempts: number;
}> {
  const { result, route, attempts } = await params.providerService.runWithFallback({
    requestedModel: params.requestedModel,
    tenantContext: params.tenantContext,
    run: async (resolvedRoute, credential) => {
      const api = resolvedRoute.provider.config.api;
      const model = resolvedRoute.model;
      const baseUrl = resolvedRoute.provider.baseUrl.replace(/\/+$/, "");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let url: string;
      let body: Record<string, unknown>;

      if (credential) {
        switch (api) {
          case "anthropic-messages":
            if (isFridayAnthropicBearerAuthMode(resolvedRoute.provider.config.authMode)) {
              headers["Authorization"] = `Bearer ${credential}`;
              Object.assign(headers, FRIDAY_ANTHROPIC_OAUTH_HEADERS);
            } else {
              headers["x-api-key"] = credential;
            }
            headers["anthropic-version"] = "2023-06-01";
            break;
          case "google-generative-ai":
            headers["x-goog-api-key"] = credential;
            break;
          default:
            headers["Authorization"] = `Bearer ${credential}`;
            break;
        }
      }

      switch (api) {
        case "openai-completions":
          url = `${baseUrl}/v1/chat/completions`;
          body = {
            model,
            messages: [{ role: "user", content: params.prompt }],
          };
          break;
        case "openai-responses":
          url = `${baseUrl}/v1/responses`;
          body = {
            model,
            input: [{ role: "user", content: params.prompt }],
          };
          break;
        case "anthropic-messages":
          url = `${baseUrl}/v1/messages`;
          body = {
            model,
            ...(isFridayAnthropicBearerAuthMode(resolvedRoute.provider.config.authMode)
              ? { system: FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX }
              : {}),
            messages: [{ role: "user", content: params.prompt }],
            max_tokens: 4096,
          };
          break;
        case "google-generative-ai":
          url = `${baseUrl}/v1beta/models/${model}:generateContent`;
          body = {
            contents: [{ role: "user", parts: [{ text: params.prompt }] }],
          };
          break;
        case "ollama":
          url = `${baseUrl}/api/chat`;
          body = {
            model,
            messages: [{ role: "user", content: params.prompt }],
            stream: false,
          };
          break;
        default:
          url = `${baseUrl}/v1/chat/completions`;
          body = {
            model,
            messages: [{ role: "user", content: params.prompt }],
          };
          break;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new FridayDomainError("EXECUTOR_PROVIDER_ERROR", `Provider returned ${res.status}`, {
          httpStatus: 502,
          retryable: res.status >= 500,
        });
      }
      const resBody = await res.json() as Record<string, unknown>;
      let text = "";

      switch (api) {
        case "openai-completions": {
          const choices = resBody["choices"] as Array<{ message?: { content?: string } }> | undefined;
          text = choices?.[0]?.message?.content ?? "";
          break;
        }
        case "openai-responses": {
          const output = resBody["output"] as
            | Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
            | undefined;
          const msgItem = output?.find((item) => item.type === "message");
          const textPart = msgItem?.content?.find((item) => item.type === "output_text");
          text = textPart?.text ?? "";
          break;
        }
        case "anthropic-messages": {
          const content = resBody["content"] as Array<{ type: string; text?: string }> | undefined;
          text = content?.find((block) => block.type === "text")?.text ?? "";
          break;
        }
        case "google-generative-ai": {
          const candidates = resBody["candidates"] as
            | Array<{ content?: { parts?: Array<{ text?: string }> } }>
            | undefined;
          text = candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          break;
        }
        case "ollama": {
          const message = resBody["message"] as { content?: string } | undefined;
          text = message?.content ?? "";
          break;
        }
        default: {
          const choices = resBody["choices"] as Array<{ message?: { content?: string } }> | undefined;
          text = choices?.[0]?.message?.content ?? "";
          break;
        }
      }

      return {
        text,
        provider: resolvedRoute.provider.kind,
        model,
        api,
        baseUrl: resolvedRoute.provider.baseUrl,
      };
    },
  });

  return {
    text: result.text,
    provider: route.provider.kind,
    model: route.model,
    api: result.api,
    baseUrl: result.baseUrl,
    attempts: attempts.length,
  };
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isMissingSkillInputValue(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  return typeof value === "string" && value.trim().length === 0;
}

function hasExpectedInputType(
  field: SkillManifestV2["inputs"][number],
  value: unknown,
): boolean {
  switch (field.type) {
    case "string":
    case "secret":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value != null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "file":
      return typeof value === "string" || (value != null && typeof value === "object");
  }
}

function validateInputField(
  field: SkillManifestV2["inputs"][number],
  value: unknown,
): string[] {
  const issues: string[] = [];
  if (!hasExpectedInputType(field, value)) {
    issues.push(`Input "${field.key}" must be of type ${field.type}.`);
    return issues;
  }

  if (typeof value === "string") {
    const pattern = field.validation?.regex;
    if (pattern) {
      try {
        const regex = new RegExp(pattern);
        if (!regex.test(value)) {
          issues.push(`Input "${field.key}" does not match the required pattern.`);
        }
      } catch {
        issues.push(`Input "${field.key}" uses an invalid regex pattern.`);
      }
    }

    if (field.validation?.enum && !field.validation.enum.includes(value)) {
      issues.push(`Input "${field.key}" must be one of: ${field.validation.enum.join(", ")}.`);
    }
  }

  if (typeof value === "number") {
    if (typeof field.validation?.min === "number" && value < field.validation.min) {
      issues.push(`Input "${field.key}" must be >= ${String(field.validation.min)}.`);
    }
    if (typeof field.validation?.max === "number" && value > field.validation.max) {
      issues.push(`Input "${field.key}" must be <= ${String(field.validation.max)}.`);
    }
  }

  return issues;
}

function prepareExecutionInput(
  manifest: SkillManifestV2,
  input: Record<string, unknown>,
): { preparedInput: Record<string, unknown>; issues: string[] } {
  const preparedInput: Record<string, unknown> = {
    ...input,
  };
  const issues: string[] = [];

  for (const field of manifest.inputs) {
    const hasOwnValue = Object.prototype.hasOwnProperty.call(preparedInput, field.key);
    if ((!hasOwnValue || preparedInput[field.key] === undefined) && field.defaultValue !== undefined) {
      preparedInput[field.key] = cloneJsonValue(field.defaultValue);
    }

    const value = preparedInput[field.key];
    if (isMissingSkillInputValue(value)) {
      if (field.required) {
        issues.push(`Missing required input "${field.key}".`);
      }
      continue;
    }

    issues.push(...validateInputField(field, value));
  }

  return { preparedInput, issues };
}

function formatSchemaErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.map((error) => {
    if (!error || typeof error !== "object") {
      return String(error);
    }
    const record = error as { instancePath?: unknown; message?: unknown };
    const path = typeof record.instancePath === "string" && record.instancePath.length > 0
      ? record.instancePath
      : "/";
    const message = typeof record.message === "string" && record.message.length > 0
      ? record.message
      : "Schema validation failed";
    return `${path} ${message}`.trim();
  });
}

function parseStructuredStdout(stdout: string): Record<string, unknown> {
  if (!looksLikeJsonValue(stdout)) {
    return { raw: stdout };
  }

  const parsed: unknown = JSON.parse(stdout);
  if (
    parsed != null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    return parsed as Record<string, unknown>;
  }
  return { result: parsed };
}

function buildRuntimeEnv(requiredEnvKeys: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const envKey of requiredEnvKeys) {
    if (process.env[envKey] != null) {
      env[envKey] = process.env[envKey]!;
    }
  }
  return env;
}

/**
 * Creates the main skill executor that routes to the correct runtime executor
 * (shell / node) based on the manifest's `runtime.kind`, and tracks run state
 * via the run store.
 */
export function createFridaySkillExecutor(
  deps: CreateFridaySkillExecutorDeps,
): FridaySkillExecutor {
  const shellExecutor = createFridayShellExecutor();
  const nodeExecutor = createFridayNodeExecutor();
  const activeRuns = new Map<string, { cancelled: boolean; controller: AbortController }>();

  return {
    execute(
      request: FridaySkillExecuteRequest,
    ): FridaySkillExecuteHandle {
      const runId = deps.idGenerator();

      // ─── ai-inference shortcut: route through provider service ───
      if (request.skillId === "ai-inference" && deps.providerService) {
        const providerService = deps.providerService;
        const tenantContext = defaultTenantContext(request);
        const result = (async (): Promise<FridaySkillExecuteResult> => {
          const start = Date.now();
          try {
            const modelHint = (request.input.model as string | undefined) ?? undefined;
            const prompt = request.input.prompt as string | undefined;
            if (!prompt) {
              return {
                runId,
                status: "failed",
                output: {},
                stdout: "",
                stderr: "ai-inference requires a 'prompt' input",
                durationMs: Date.now() - start,
              };
            }
            const inference = await runProviderInference({
              providerService,
              tenantContext,
              prompt,
              requestedModel: modelHint,
            });
            return {
              runId,
              status: "completed",
              output: {
                text: inference.text,
                result: inference.text,
                provider: inference.provider,
                model: inference.model,
                api: inference.api,
                attempts: inference.attempts,
              },
              stdout: inference.text,
              stderr: "",
              durationMs: Date.now() - start,
            };
          } catch (err) {
            return {
              runId,
              status: "failed",
              output: {},
              stdout: "",
              stderr: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - start,
            };
          }
        })();
        return { runId, result };
      }

      // Look up skill in registry — return early handle with resolved promise on failure
      const registered = deps.registry.get(request.skillId);
      if (!registered) {
        return {
          runId,
          result: Promise.resolve({
            runId,
            status: "failed",
            output: {},
            stdout: "",
            stderr: `Skill '${request.skillId}' not found in registry`,
            durationMs: 0,
          }),
        };
      }

      const controller = new AbortController();
      activeRuns.set(runId, { cancelled: false, controller });

      const result = (async (): Promise<FridaySkillExecuteResult> => {
        const now = deps.nowIso();
        const manifest = registered.manifest;
        const timeoutMs =
          request.timeoutMs ?? manifest.runtime.timeoutMsDefault;

        // Create initial run snapshot
        const snapshot: FridaySkillRunSnapshot = {
          runId,
          skillId: manifest.id,
          version: manifest.version,
          status: "running",
          currentStepId: "execute",
          attemptsByStep: { execute: 1 },
          state: {},
          startedAt: now,
          updatedAt: now,
          sessionId: request.sessionId,
          userId: request.userId,
          channel: request.channel,
          lastTransitionAt: now,
        };

        deps.runStore.upsertRun(snapshot);

        let execResult: FridaySkillExecuteResult | null = null;
        const schemaValidation = {
          compiled: false,
          inputValidated: false,
          outputValidated: false,
        };

        try {
          const readiness = evaluateFridaySkillExecutionReadiness({ manifest });
          if (!readiness.ready) {
            execResult = {
              runId,
              status: "failed",
              output: {
                code: "SKILL_NOT_READY",
                runtimeKind: manifest.runtime.kind,
                blockers: readiness.blockers,
                requirements: readiness.requirements,
              },
              stdout: "",
              stderr: readiness.blockers.join(" "),
              durationMs: 0,
            };
          } else {
            const { preparedInput, issues: inputIssues } = prepareExecutionInput(
              manifest,
              request.input,
            );
            if (inputIssues.length > 0) {
              execResult = {
                runId,
                status: "failed",
                output: {
                  code: "SKILL_INPUT_INVALID",
                  runtimeKind: manifest.runtime.kind,
                  issues: inputIssues,
                },
                stdout: "",
                stderr: inputIssues.join(" "),
                durationMs: 0,
              };
            } else {
              const schemaCompilation = compileFridaySkillSchemas({
                manifest,
                skillDir: registered.skillDir,
              });
              const schemaCompileErrors = schemaCompilation.issues.filter(
                (issue) => issue.severity === "error",
              );
              const compiledSchemas = schemaCompilation.compiled;
              schemaValidation.compiled = Boolean(
                manifest.schemas?.input || manifest.schemas?.state || manifest.schemas?.output,
              );

              if (schemaCompileErrors.length > 0) {
                execResult = {
                  runId,
                  status: "failed",
                  output: {
                    code: "SKILL_SCHEMA_INVALID",
                    runtimeKind: manifest.runtime.kind,
                    issues: schemaCompileErrors.map((issue) => issue.message),
                  },
                  stdout: "",
                  stderr: schemaCompileErrors.map((issue) => issue.message).join(" "),
                  durationMs: 0,
                };
              } else if (compiledSchemas.input) {
                schemaValidation.inputValidated = true;
                const validInput = compiledSchemas.input(preparedInput);
                if (!validInput) {
                  const schemaErrors = formatSchemaErrors(compiledSchemas.input.errors);
                  execResult = {
                    runId,
                    status: "failed",
                    output: {
                      code: "SKILL_INPUT_SCHEMA_INVALID",
                      runtimeKind: manifest.runtime.kind,
                      issues: schemaErrors,
                    },
                    stdout: "",
                    stderr: schemaErrors.join(" "),
                    durationMs: 0,
                  };
                }
              }

              if (!execResult) {
                switch (manifest.runtime.kind) {
                  case "shell": {
                    const entrypoint = resolve(
                      registered.skillDir,
                      manifest.runtime.entrypoint,
                    );
                    const shellResult = await shellExecutor.run({
                      command: entrypoint,
                      cwd: registered.skillDir,
                      env: buildRuntimeEnv(manifest.requirements.env),
                      timeoutMs,
                      stdin: JSON.stringify(preparedInput),
                      signal: controller.signal,
                    });

                    if (shellResult.cancelled) {
                      execResult = {
                        runId,
                        status: "cancelled",
                        output: {},
                        stdout: shellResult.stdout,
                        stderr: shellResult.stderr,
                        durationMs: shellResult.durationMs,
                      };
                    } else if (shellResult.timedOut) {
                      execResult = {
                        runId,
                        status: "timeout",
                        output: {},
                        stdout: shellResult.stdout,
                        stderr: shellResult.stderr,
                        durationMs: shellResult.durationMs,
                      };
                    } else if (shellResult.exitCode !== 0) {
                      execResult = {
                        runId,
                        status: "failed",
                        output: {},
                        stdout: shellResult.stdout,
                        stderr: shellResult.stderr,
                        durationMs: shellResult.durationMs,
                      };
                    } else {
                      let output: Record<string, unknown>;
                      try {
                        output = parseStructuredStdout(shellResult.stdout);
                      } catch (err) {
                        console.warn("[friday][skill-executor] operation failed:", err instanceof Error ? err.message : String(err));
                        output = { raw: shellResult.stdout };
                      }

                      execResult = {
                        runId,
                        status: "completed",
                        output,
                        stdout: shellResult.stdout,
                        stderr: shellResult.stderr,
                        durationMs: shellResult.durationMs,
                      };
                    }
                    break;
                  }

                  case "python": {
                    const pythonCommand = resolveFridayPythonCommand();
                    if (!pythonCommand) {
                      execResult = {
                        runId,
                        status: "failed",
                        output: {
                          code: "SKILL_NOT_READY",
                          runtimeKind: "python",
                          blockers: [getFridayPythonRuntimeUnavailableMessage()],
                        },
                        stdout: "",
                        stderr: getFridayPythonRuntimeUnavailableMessage(),
                        durationMs: 0,
                      };
                      break;
                    }

                    const entrypoint = resolve(
                      registered.skillDir,
                      manifest.runtime.entrypoint,
                    );
                    const pythonResult = await shellExecutor.run({
                      command: pythonCommand,
                      args: [entrypoint],
                      cwd: registered.skillDir,
                      env: buildRuntimeEnv(manifest.requirements.env),
                      timeoutMs,
                      stdin: JSON.stringify(preparedInput),
                      signal: controller.signal,
                    });

                    if (pythonResult.cancelled) {
                      execResult = {
                        runId,
                        status: "cancelled",
                        output: {},
                        stdout: pythonResult.stdout,
                        stderr: pythonResult.stderr,
                        durationMs: pythonResult.durationMs,
                      };
                    } else if (pythonResult.timedOut) {
                      execResult = {
                        runId,
                        status: "timeout",
                        output: {},
                        stdout: pythonResult.stdout,
                        stderr: pythonResult.stderr,
                        durationMs: pythonResult.durationMs,
                      };
                    } else if (pythonResult.exitCode !== 0) {
                      execResult = {
                        runId,
                        status: "failed",
                        output: {},
                        stdout: pythonResult.stdout,
                        stderr: pythonResult.stderr,
                        durationMs: pythonResult.durationMs,
                      };
                    } else {
                      let output: Record<string, unknown>;
                      try {
                        output = parseStructuredStdout(pythonResult.stdout);
                      } catch (err) {
                        console.warn("[friday][skill-executor] operation failed:", err instanceof Error ? err.message : String(err));
                        output = { raw: pythonResult.stdout };
                      }

                      execResult = {
                        runId,
                        status: "completed",
                        output,
                        stdout: pythonResult.stdout,
                        stderr: pythonResult.stderr,
                        durationMs: pythonResult.durationMs,
                      };
                    }
                    break;
                  }

                  case "node": {
                    const allowBundledSystemNodeSkill = canRunFridayBundledSystemNodeSkillWithoutGate({
                      runtimeKind: manifest.runtime.kind,
                      manifestKind: manifest.kind,
                      source: registered.source,
                      origin: registered.origin,
                    });
                    if (!allowBundledSystemNodeSkill && !isFridayUnisolatedNodeSkillsEnabled()) {
                      execResult = {
                        runId,
                        status: "failed",
                        output: {
                          code: "CAPABILITY_DISABLED",
                          capability: "skill_node_runtime",
                          runtimeKind: "node",
                          gate: FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
                        },
                        stdout: "",
                        stderr: getFridayUnisolatedNodeSkillsDisabledMessage(),
                        durationMs: 0,
                      };
                      break;
                    }

                    let aiHelper: FridaySkillAiHelperContext | undefined;
                    if (deps.providerService) {
                      const ps = deps.providerService;
                      const tenantContext = defaultTenantContext(request);
                      aiHelper = {
                        async infer(prompt: string, requestedModel?: string): Promise<string> {
                          const inference = await runProviderInference({
                            providerService: ps,
                            tenantContext,
                            prompt,
                            requestedModel,
                          });
                          return inference.text;
                        },
                      };
                    }

                    const runtimeContext = createFridaySkillReadonlyRuntimeContext(deps, request);
                    const nodeResult = await nodeExecutor.run({
                      entrypoint: manifest.runtime.entrypoint,
                      input: preparedInput,
                      cwd: registered.skillDir,
                      timeoutMs,
                      signal: controller.signal,
                      allowWithoutGate: allowBundledSystemNodeSkill,
                      aiHelper,
                      runtimeContext,
                    });

                    const runState = activeRuns.get(runId);
                    if (runState?.cancelled) {
                      execResult = {
                        runId,
                        status: "cancelled",
                        output: {},
                        stdout: "",
                        stderr: "",
                        durationMs: nodeResult.durationMs,
                      };
                    } else if (nodeResult.timedOut) {
                      execResult = {
                        runId,
                        status: "timeout",
                        output: {},
                        stdout: "",
                        stderr: nodeResult.error ?? "",
                        durationMs: nodeResult.durationMs,
                      };
                    } else if (nodeResult.error) {
                      execResult = {
                        runId,
                        status: "failed",
                        output: {},
                        stdout: "",
                        stderr: nodeResult.error,
                        durationMs: nodeResult.durationMs,
                      };
                    } else {
                      execResult = {
                        runId,
                        status: "completed",
                        output: nodeResult.output,
                        stdout: "",
                        stderr: "",
                        durationMs: nodeResult.durationMs,
                      };
                    }
                    break;
                  }

                  case "builtin": {
                    execResult = {
                      runId,
                      status: "failed",
                      output: {},
                      stdout: "",
                      stderr: `Skill "${manifest.id}" is a conversation skill and cannot be run from the CLI. Use the web UI chat or POST /v1/sessions/:key/run instead.`,
                      durationMs: 0,
                    };
                    break;
                  }

                  default: {
                    execResult = {
                      runId,
                      status: "failed",
                      output: {},
                      stdout: "",
                      stderr: `Unsupported runtime kind: '${manifest.runtime.kind}'`,
                      durationMs: 0,
                    };
                  }
                }
              }

              if (execResult?.status === "completed" && compiledSchemas.output) {
                schemaValidation.outputValidated = true;
                const validOutput = compiledSchemas.output(execResult.output);
                if (!validOutput) {
                  const schemaErrors = formatSchemaErrors(compiledSchemas.output.errors);
                  execResult = {
                    runId,
                    status: "failed",
                    output: {
                      code: "SKILL_OUTPUT_SCHEMA_INVALID",
                      runtimeKind: manifest.runtime.kind,
                      issues: schemaErrors,
                    },
                    stdout: execResult.stdout,
                    stderr: schemaErrors.join(" "),
                    durationMs: execResult.durationMs,
                  };
                }
              }
            }
          }
        } catch (err) {
          // Should not happen — sub-executors never throw on skill failure.
          // This catches truly unexpected errors (bad imports, etc.)
          execResult = {
            runId,
            status: "failed",
            output: {},
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            durationMs: 0,
          };
        } finally {
          activeRuns.delete(runId);
        }

        // Persist final run state
        const finalResult = execResult ?? {
          runId,
          status: "failed" as const,
          output: {},
          stdout: "",
          stderr: "Skill execution did not produce a terminal result",
          durationMs: 0,
        };

        const terminalStatus =
          finalResult.status === "completed"
            ? "completed"
            : finalResult.status === "cancelled"
              ? "cancelled"
              : "failed";

        const finalNow = deps.nowIso();
        deps.runStore.upsertRun({
          ...snapshot,
          status: terminalStatus,
          updatedAt: finalNow,
          lastTransitionAt: finalNow,
          metadata: {
            durationMs: finalResult.durationMs,
            timedOut: finalResult.status === "timeout",
            runtimeKind: manifest.runtime.kind,
            declaredTelemetryEvents: manifest.telemetry?.events ?? [],
            schemaValidation,
          },
        });

        return finalResult;
      })();

      return { runId, result };
    },

    cancel(runId: string): void {
      const runState = activeRuns.get(runId);
      if (runState) {
        runState.cancelled = true;
        runState.controller.abort();
      }
    },
  };
}

function looksLikeJsonValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === "true" || trimmed === "false" || trimmed === "null") return true;
  const first = trimmed[0];
  return (
    first === "{" ||
    first === "[" ||
    first === '"' ||
    first === "-" ||
    (first >= "0" && first <= "9")
  );
}
