import type {
  CreateFridaySkillExecutorDeps,
  FridaySkillAiHelperContext,
  FridaySkillExecuteHandle,
  FridaySkillExecuteRequest,
  FridaySkillExecuteResult,
  FridaySkillExecutor,
} from "./friday-skill-executor.types.js";
import type { FridaySkillRunSnapshot } from "#ledger";
import { FridayDomainError } from "#errors";
import { createFridayShellExecutor } from "./friday-shell-executor.js";
import { createFridayNodeExecutor } from "./friday-node-executor.js";
import { resolve } from "node:path";

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
            const { result: aiResult, route, attempts } = await providerService.runWithFallback({
              requestedModel: modelHint,
              run: async (r, credential) => {
                // Return the resolved route info for the caller to use
                return { route: r, credential, prompt };
              },
            });
            return {
              runId,
              status: "completed",
              output: {
                provider: route.provider.kind,
                model: route.model,
                prompt: aiResult.prompt,
                credential: aiResult.credential ? "[REDACTED]" : null,
                baseUrl: aiResult.route.provider.baseUrl,
                api: aiResult.route.provider.config.api,
                attempts: attempts.length,
              },
              stdout: "",
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

        let execResult: FridaySkillExecuteResult;

        try {
          switch (manifest.runtime.kind) {
            case "shell": {
              const entrypoint = resolve(
                registered.skillDir,
                manifest.runtime.entrypoint,
              );

              // Build env from skill requirements
              const env: Record<string, string> = {};
              for (const envKey of manifest.requirements.env) {
                if (process.env[envKey] != null) {
                  env[envKey] = process.env[envKey]!;
                }
              }

              // Pass input as JSON via stdin
              const shellResult = await shellExecutor.run({
                command: entrypoint,
                cwd: registered.skillDir,
                env,
                timeoutMs,
                stdin: JSON.stringify(request.input),
                signal: controller.signal,
              });

              // Check if cancelled during execution
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
                // Try to parse stdout as JSON output
                let output: Record<string, unknown> = {};
                try {
                  const parsed: unknown = JSON.parse(shellResult.stdout);
                  if (
                    parsed != null &&
                    typeof parsed === "object" &&
                    !Array.isArray(parsed)
                  ) {
                    output = parsed as Record<string, unknown>;
                  } else {
                    output = { result: parsed };
                  }
                } catch {
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

            case "node": {
              // Build optional AI helper context for BYOK-backed node skills
              let aiHelper: FridaySkillAiHelperContext | undefined;
              if (deps.providerService) {
                const ps = deps.providerService;
                aiHelper = {
                  async infer(prompt: string, requestedModel?: string): Promise<string> {
                    const { result } = await ps.runWithFallback({
                      requestedModel,
                      run: async (route, credential) => {
                        const api = route.provider.config.api;
                        const model = route.model;
                        const baseUrl = route.provider.baseUrl.replace(/\/+$/, "");

                        let url: string;
                        const headers: Record<string, string> = { "Content-Type": "application/json" };
                        let body: Record<string, unknown>;

                        // ── Auth headers per provider ──
                        if (credential) {
                          switch (api) {
                            case "anthropic-messages":
                              headers["x-api-key"] = credential;
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

                        // ── Build URL + body per API format ──
                        switch (api) {
                          case "openai-completions":
                            url = `${baseUrl}/v1/chat/completions`;
                            body = {
                              model,
                              messages: [{ role: "user", content: prompt }],
                            };
                            break;

                          case "openai-responses":
                            url = `${baseUrl}/v1/responses`;
                            body = {
                              model,
                              input: [{ role: "user", content: prompt }],
                            };
                            break;

                          case "anthropic-messages":
                            url = `${baseUrl}/v1/messages`;
                            body = {
                              model,
                              messages: [{ role: "user", content: prompt }],
                              max_tokens: 4096,
                            };
                            break;

                          case "google-generative-ai":
                            url = `${baseUrl}/v1beta/models/${model}:generateContent`;
                            body = {
                              contents: [
                                { role: "user", parts: [{ text: prompt }] },
                              ],
                            };
                            break;

                          case "ollama":
                            url = `${baseUrl}/api/chat`;
                            body = {
                              model,
                              messages: [{ role: "user", content: prompt }],
                              stream: false,
                            };
                            break;

                          default:
                            // Fallback to openai-completions format
                            url = `${baseUrl}/v1/chat/completions`;
                            body = {
                              model,
                              messages: [{ role: "user", content: prompt }],
                            };
                            break;
                        }

                        const res = await fetch(url, {
                          method: "POST",
                          headers,
                          body: JSON.stringify(body),
                        });
                        if (!res.ok) {
                          throw new FridayDomainError("EXECUTOR_PROVIDER_ERROR", `Provider returned ${res.status}`, { httpStatus: 502, retryable: res.status >= 500 });
                        }
                        const resBody = await res.json() as Record<string, unknown>;

                        // ── Extract text from response per API format ──
                        switch (api) {
                          case "openai-completions": {
                            const choices = resBody["choices"] as Array<{ message?: { content?: string } }> | undefined;
                            return choices?.[0]?.message?.content ?? "";
                          }

                          case "openai-responses": {
                            const output = resBody["output"] as
                              | Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
                              | undefined;
                            const msgItem = output?.find((o) => o.type === "message");
                            const textPart = msgItem?.content?.find((c) => c.type === "output_text");
                            return textPart?.text ?? "";
                          }

                          case "anthropic-messages": {
                            const content = resBody["content"] as Array<{ type: string; text?: string }> | undefined;
                            return content?.find((b) => b.type === "text")?.text ?? "";
                          }

                          case "google-generative-ai": {
                            const candidates = resBody["candidates"] as
                              | Array<{ content?: { parts?: Array<{ text?: string }> } }>
                              | undefined;
                            return candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                          }

                          case "ollama": {
                            const message = resBody["message"] as { content?: string } | undefined;
                            return message?.content ?? "";
                          }

                          default: {
                            const choices = resBody["choices"] as Array<{ message?: { content?: string } }> | undefined;
                            return choices?.[0]?.message?.content ?? "";
                          }
                        }
                      },
                    });
                    return result;
                  },
                };
              }

              const nodeResult = await nodeExecutor.run({
                entrypoint: manifest.runtime.entrypoint,
                input: request.input,
                cwd: registered.skillDir,
                timeoutMs,
                signal: controller.signal,
                aiHelper,
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
        const terminalStatus =
          execResult.status === "completed"
            ? "completed"
            : execResult.status === "cancelled"
              ? "cancelled"
              : "failed";

        const finalNow = deps.nowIso();
        deps.runStore.upsertRun({
          ...snapshot,
          status: terminalStatus,
          updatedAt: finalNow,
          lastTransitionAt: finalNow,
          metadata: {
            durationMs: execResult.durationMs,
            timedOut: execResult.status === "timeout",
          },
        });

        return execResult;
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
