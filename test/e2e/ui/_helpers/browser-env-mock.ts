import * as fs from "node:fs";
import * as path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV } from "#skills";

import {
  createMockHubEnv,
  type MockHubEnv,
} from "../../mock/_helpers/mock-env.js";
import type { FridayProviderKind } from "../../../../src/providers/model/friday-provider.types.js";

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: {
    code?: string;
    message?: string;
  };
}

export interface FridayBrowserPageHandle {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export interface FridayMockBrowserE2eEnv {
  hubEnv: MockHubEnv;
  browser: Browser;
  baseUrl: string;
  accessToken: string;
  apiFetch<T>(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: ApiEnvelope<T> }>;
  newPage(): Promise<FridayBrowserPageHandle>;
  cleanup(): Promise<void>;
}

function resolveUiStaticDir(): string {
  const uiStaticDir = path.resolve(process.cwd(), "dist/ui");
  const indexPath = path.join(uiStaticDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `Built UI not found at ${indexPath}. Run "npm run build:ui" or use "npm run test:e2e:ui".`,
    );
  }
  return uiStaticDir;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function completeSetup(hubEnv: MockHubEnv): Promise<void> {
  const response = await fetch(`${hubEnv.baseUrl}/v1/setup/complete`, {
    method: "POST",
    headers: authHeaders(hubEnv.accessToken),
    body: JSON.stringify({
      completedSteps: [
        "welcome",
        "security",
        "communication",
        "provider",
        "network",
        "channels",
        "skills",
        "done",
      ],
      skippedSteps: [],
    }),
  });
  const json = (await response.json()) as ApiEnvelope<{ setupCompletedAt: string }>;
  if (!response.ok || !json.ok) {
    throw new Error(`Failed to complete setup for browser E2E: ${JSON.stringify(json)}`);
  }
}

export async function createFridayMockBrowserE2eEnv(input?: {
  providerKinds?: FridayProviderKind[];
}): Promise<FridayMockBrowserE2eEnv> {
  const previousNodeRuntimeFlag = process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
  process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = "true";

  const restoreNodeRuntimeFlag = (): void => {
    if (previousNodeRuntimeFlag === undefined) {
      delete process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV];
    } else {
      process.env[FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV] = previousNodeRuntimeFlag;
    }
  };

  try {
    const hubEnv = await createMockHubEnv({
      providerKinds: input?.providerKinds ?? ["ollama"],
      uiStaticDir: resolveUiStaticDir(),
    });
    await completeSetup(hubEnv);
    const browser = await chromium.launch({ headless: true });

    return {
      hubEnv,
      browser,
      baseUrl: hubEnv.baseUrl,
      accessToken: hubEnv.accessToken,
      async apiFetch<T>(method: string, urlPath: string, body?: unknown) {
        const response = await fetch(`${hubEnv.baseUrl}${urlPath}`, {
          method,
          headers: authHeaders(hubEnv.accessToken),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          json: (await response.json()) as ApiEnvelope<T>,
        };
      },
      async newPage() {
        const onboardedProfile = {
          profileType: "developer",
          onboardedAt: new Date().toISOString(),
        };
        const seededUser = {
          id: "browser-e2e-user",
          email: "browser-e2e@friday.dev",
          displayName: "Browser E2E",
          role: "admin",
        };
        const context = await browser.newContext({
          baseURL: hubEnv.baseUrl,
          timezoneId: "America/Los_Angeles",
        });

        await context.addInitScript({
          content: `
            window.localStorage.setItem("friday.uix.user-profile", ${JSON.stringify(JSON.stringify(onboardedProfile))});
            window.localStorage.setItem("friday.auth.accessToken", ${JSON.stringify(hubEnv.accessToken)});
            window.localStorage.setItem("friday.auth.refreshToken", ${JSON.stringify(hubEnv.accessToken)});
            window.localStorage.setItem("friday.auth.user", ${JSON.stringify(JSON.stringify(seededUser))});
          `,
        });
        const page = await context.newPage();

        return {
          context,
          page,
          async close() {
            await context.close();
          },
        };
      },
      async cleanup() {
        try {
          await browser.close();
          await hubEnv.cleanup();
        } finally {
          restoreNodeRuntimeFlag();
        }
      },
    };
  } catch (error) {
    restoreNodeRuntimeFlag();
    throw error;
  }
}
