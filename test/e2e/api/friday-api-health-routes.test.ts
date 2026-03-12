import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createFridayApiTestEnv,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

describe("GET /v1/health (e2e)", () => {
  let env: FridayApiTestEnv;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
  });

  afterAll(async () => {
    await env.close();
  });

  it("returns 200 with ok status", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);
    expect(res.status).toBe(200);

    const json = await res.json() as {
      ok: boolean;
      data: { status: string; version: string; uptime: number };
      requestId: string;
    };

    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("ok");
  });

  it("includes version string in response", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);
    const json = await res.json() as {
      ok: boolean;
      data: { status: string; version: string; uptime: number };
    };

    expect(typeof json.data.version).toBe("string");
    expect(json.data.version.length).toBeGreaterThan(0);
  });

  it("includes uptime as a number", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);
    const json = await res.json() as {
      ok: boolean;
      data: { status: string; version: string; uptime: number };
    };

    expect(typeof json.data.uptime).toBe("number");
    expect(json.data.uptime).toBeGreaterThanOrEqual(0);
  });

  it("does not require authentication", async () => {
    // No Authorization header — should still succeed
    const res = await fetch(`${env.baseUrl}/v1/health`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("includes requestId in response", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);
    const json = await res.json() as {
      ok: boolean;
      data: unknown;
      requestId: string;
    };

    expect(typeof json.requestId).toBe("string");
    expect(json.requestId.length).toBeGreaterThan(0);
  });

  it("returns JSON content type", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("application/json");
  });
});
