import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";

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

export interface FridayRealBrowserE2eEnv {
  hub: FridayHub;
  httpServer: FridayHttpServer;
  browser: Browser;
  baseUrl: string;
  stateDir: string;
  accessToken: string;
  refreshToken?: string;
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
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

      // Seed the user profile in localStorage so the onboarding gate is skipped
      // even before the API call resolves in the browser.
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
      await browser.close();
      await hubEnv.cleanup();
    },
  };
}

export async function createFridayRealBrowserE2eEnv(): Promise<FridayRealBrowserE2eEnv> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-real-browser-e2e-"));
  const hub = await createFridayHub({
    stateDir,
    skillDirs: [],
    port: 0,
    logRequests: false,
  });
  await hub.start();

  const port = await findFreePort();
  const httpServer = createFridayHttpServer({
    routes: hub.apiRuntime.routes,
    wsGateway: hub.apiRuntime.wsGateway,
    middleware: hub.apiRuntime.middleware,
    port,
    host: "127.0.0.1",
    logRequests: false,
    uiStaticDir: resolveUiStaticDir(),
  });
  await httpServer.listen();
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local: true }),
  });
  const loginJson = (await loginRes.json()) as {
    ok: boolean;
    data: { accessToken: string; refreshToken: string };
  };
  if (!loginJson.ok) {
    throw new Error(`Failed to establish real browser E2E admin session: ${JSON.stringify(loginJson)}`);
  }

  const browser = await chromium.launch({ headless: true });

  return {
    hub,
    httpServer,
    browser,
    baseUrl,
    stateDir,
    accessToken: loginJson.data.accessToken,
    refreshToken: loginJson.data.refreshToken,
    async apiFetch<T>(method: string, urlPath: string, body?: unknown) {
      const response = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: authHeaders(loginJson.data.accessToken),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        json: (await response.json()) as ApiEnvelope<T>,
      };
    },
    async newPage() {
      const context = await browser.newContext({
        baseURL: baseUrl,
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
      await httpServer.close();
      await hub.stop();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
