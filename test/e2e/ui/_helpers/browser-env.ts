import * as fs from "node:fs";
import * as path from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

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

export interface FridayBrowserE2eEnv {
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

export async function createFridayBrowserE2eEnv(input?: {
  providerKinds?: FridayProviderKind[];
}): Promise<FridayBrowserE2eEnv> {
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
      const context = await browser.newContext({
        baseURL: hubEnv.baseUrl,
        timezoneId: "America/Los_Angeles",
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
      await browser.close();
      await hubEnv.cleanup();
    },
  };
}
