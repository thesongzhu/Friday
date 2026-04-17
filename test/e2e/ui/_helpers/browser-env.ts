import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  authHeaders,
  createRealHubEnvFromStateDir,
  shutdownRealHubEnv,
  type RealHubEnv,
} from "../../live/_helpers/real-env.js";

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

export interface FridayRealBrowserE2eEnv {
  hub: NonNullable<RealHubEnv["hub"]>;
  httpServer: NonNullable<RealHubEnv["httpServer"]>;
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

export async function createFridayRealBrowserE2eEnv(): Promise<FridayRealBrowserE2eEnv> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-real-browser-e2e-"));
  let runtime: RealHubEnv;
  try {
    runtime = await createRealHubEnvFromStateDir(stateDir, {
      uiStaticDir: resolveUiStaticDir(),
    });
  } catch (error) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
  if (!runtime.hub || !runtime.httpServer || !runtime.stateDir) {
    await shutdownRealHubEnv(runtime, { removeStateDir: true });
    throw new Error("createFridayRealBrowserE2eEnv requires a local runtime with hub/httpServer/stateDir");
  }

  const browser = await chromium.launch({ headless: true });

  return {
    hub: runtime.hub,
    httpServer: runtime.httpServer,
    browser,
    baseUrl: runtime.baseUrl,
    stateDir: runtime.stateDir,
    accessToken: runtime.accessToken,
    refreshToken: runtime.refreshToken,
    async apiFetch<T>(method: string, urlPath: string, body?: unknown) {
      const response = await fetch(`${runtime.baseUrl}${urlPath}`, {
        method,
        headers: authHeaders(runtime.accessToken),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        json: (await response.json()) as ApiEnvelope<T>,
      };
    },
    async newPage() {
      const context = await browser.newContext({
        baseURL: runtime.baseUrl,
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
      await shutdownRealHubEnv(runtime, { removeStateDir: true });
    },
  };
}
