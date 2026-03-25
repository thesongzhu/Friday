import * as fs from "node:fs/promises";
import * as path from "node:path";
import { browserArtifactDir, sanitizeArtifactPathSegment } from "#browser";
import type {
  CreateFridaySkillExecutorDeps,
  FridaySkillExecuteRequest,
  FridaySkillNodeRuntimeContext,
} from "./friday-skill-executor.types.js";

function toJsonRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cloneJson(item))
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object" && !Array.isArray(item));
}

function toJsonRecordOrNull(value: unknown): Record<string, unknown> | null {
  const cloned = cloneJson(value);
  if (cloned == null || typeof cloned !== "object" || Array.isArray(cloned)) {
    return null;
  }
  return cloned as Record<string, unknown>;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createFridaySkillReadonlyRuntimeContext(
  deps: Pick<CreateFridaySkillExecutorDeps, "getSelfHealingService" | "getSystemService" | "getBrowserManager" | "getChannelRegistry">,
  request: Pick<FridaySkillExecuteRequest, "userId" | "sessionId" | "skillId">,
): Omit<FridaySkillNodeRuntimeContext, "ai"> | undefined {
  const runtimeContext: Omit<FridaySkillNodeRuntimeContext, "ai"> = {};
  const systemService = deps.getSystemService?.();
  const selfHealingService = deps.getSelfHealingService?.();
  const browserManager = deps.getBrowserManager?.();
  const channelRegistry = deps.getChannelRegistry?.();

  if (systemService) {
    runtimeContext.system = {
      async getSnapshot(): Promise<Record<string, unknown>> {
        return toJsonRecordOrNull(await systemService.getState()) ?? {};
      },
    };
  }

  if (selfHealingService) {
    runtimeContext.diagnosis = {
      async listIssueCards(limit?: number): Promise<Record<string, unknown>[]> {
        return toJsonRecordArray(selfHealingService.listIssueCards({
          userId: request.userId,
          limit,
        }));
      },
      async listIncidents(limit?: number): Promise<Record<string, unknown>[]> {
        return toJsonRecordArray(selfHealingService.listIncidents({
          userId: request.userId,
          limit,
        }));
      },
      async getIncident(incidentId: string): Promise<Record<string, unknown> | null> {
        return toJsonRecordOrNull(selfHealingService.getIncident({ incidentId }));
      },
    };
    runtimeContext.autofix = {
      async listActions(limit?: number, status?: string): Promise<Record<string, unknown>[]> {
        return toJsonRecordArray(selfHealingService.listActions({
          userId: request.userId,
          limit,
          status,
        }));
      },
      async getAction(actionId: string): Promise<Record<string, unknown> | null> {
        return toJsonRecordOrNull(selfHealingService.getAction({ actionId }));
      },
    };
  }

  if (browserManager) {
    runtimeContext.browser = {
      async inspectPage(input) {
        const requestedUrl = typeof input.url === "string" ? input.url.trim() : "";
        if (requestedUrl.length === 0) {
          throw new Error("Browser inspection requires a non-empty url.");
        }

        const requestedSessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        const sessionId = requestedSessionId.length > 0
          ? requestedSessionId
          : [
            "skill",
            request.skillId,
            request.userId,
            request.sessionId,
          ]
            .map((part) => sanitizeArtifactPathSegment(part))
            .join("_");

        const launchResult = await browserManager.launch(sessionId, undefined, undefined, {
          presentationMode: "headless",
          interactive: false,
          source: `skill:${request.skillId}`,
        });
        const { tabId, page } = await browserManager.getPage(
          sessionId,
          { tabId: launchResult.tabId },
        );

        const consoleErrors: Array<{ type: string; text: string }> = [];
        const consoleWarnings: Array<{ type: string; text: string }> = [];
        const pageErrors: string[] = [];
        const requestFailures: Array<{ url: string; method: string; failureText: string | null }> = [];

        const onConsole = (message: { type(): string; text(): string }) => {
          const type = message.type();
          const text = message.text();
          if (type === "error") {
            consoleErrors.push({ type, text });
          } else if (type === "warning") {
            consoleWarnings.push({ type, text });
          }
        };
        const onPageError = (error: Error) => {
          pageErrors.push(error.message);
        };
        const onRequestFailed = (failedRequest: {
          url(): string;
          method(): string;
          failure(): { errorText?: string } | null;
        }) => {
          requestFailures.push({
            url: failedRequest.url(),
            method: failedRequest.method(),
            failureText: failedRequest.failure()?.errorText ?? null,
          });
        };

        page.on("console", onConsole);
        page.on("pageerror", onPageError);
        page.on("requestfailed", onRequestFailed);

        try {
          if (input.viewport?.width && input.viewport?.height) {
            await page.setViewportSize({
              width: input.viewport.width,
              height: input.viewport.height,
            });
          }

          const response = await page.goto(requestedUrl, {
            waitUntil: input.waitUntil ?? "load",
            timeout: input.timeoutMs ?? browserManager.options.navigationTimeoutMs,
          });
          const snapshot = await browserManager.snapshotAria(sessionId, { tabId });
          const performanceTiming = await page.evaluate(() => {
            const getEntriesByType = performance.getEntriesByType.bind(performance) as unknown as
              (entryType: string) => unknown[];
            const navigationEntry = getEntriesByType("navigation")?.[0];
            if (!navigationEntry || typeof navigationEntry !== "object") {
              return {
                domContentLoadedMs: null,
                loadMs: null,
              };
            }
            const entry = navigationEntry as {
              domContentLoadedEventEnd?: number;
              loadEventEnd?: number;
            };
            const domContentLoadedEventEnd = entry.domContentLoadedEventEnd;
            const loadEventEnd = entry.loadEventEnd;
            return {
              domContentLoadedMs: typeof domContentLoadedEventEnd === "number" && Number.isFinite(domContentLoadedEventEnd)
                ? Math.round(domContentLoadedEventEnd)
                : null,
              loadMs: typeof loadEventEnd === "number" && Number.isFinite(loadEventEnd)
                ? Math.round(loadEventEnd)
                : null,
            };
          }) as { domContentLoadedMs: number | null; loadMs: number | null };

          let screenshotPath: string | null = null;
          try {
            const artifactRoot = browserArtifactDir(browserManager.options.workspaceRoot, sessionId);
            await fs.mkdir(artifactRoot, { recursive: true });
            const screenshotName = sanitizeArtifactPathSegment(input.screenshotName ?? `${request.skillId}-snapshot`);
            screenshotPath = path.join(artifactRoot, `${screenshotName}.png`);
            await page.screenshot({
              path: screenshotPath,
              fullPage: true,
            });
          } catch {
            screenshotPath = null;
          }

          return {
            sessionId,
            tabId,
            title: await page.title(),
            finalUrl: page.url(),
            requestedUrl,
            status: response?.status() ?? null,
            snapshot,
            screenshotPath,
            consoleErrors,
            consoleWarnings,
            pageErrors,
            requestFailures,
            timings: performanceTiming,
          };
        } finally {
          page.off("console", onConsole);
          page.off("pageerror", onPageError);
          page.off("requestfailed", onRequestFailed);
        }
      },
      async closeSession(sessionId: string) {
        await browserManager.close(sessionId);
      },
    };
  }

  if (channelRegistry) {
    runtimeContext.channels = {
      async listChannels() {
        return cloneJson(channelRegistry.listViews());
      },
      async getChannel(kind: string) {
        return cloneJson(channelRegistry.describe(kind) ?? null);
      },
    };
  }

  return Object.keys(runtimeContext).length > 0 ? runtimeContext : undefined;
}
