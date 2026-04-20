import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FridayApiTestEnv } from "./_helpers/friday-api-test-server.helper.js";
import {
  authHeaders,
  createFridayApiTestEnv,
  loginTestUser,
} from "./_helpers/friday-api-test-server.helper.js";

describe("TUI API routes (e2e)", () => {
  let env: FridayApiTestEnv;
  let accessToken: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
    ({ accessToken } = await loginTestUser(env.baseUrl));

    const createSession = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        ...authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        accountId: "acct-1",
        chatId: "chat-1",
      }),
    });
    expect(createSession.status).toBe(200);

    env.db.writer.prepare(
      `INSERT INTO friday_scheduler_jobs (
        id, interval_ms, timeout_ms, catch_up_runs, enabled, next_run_at, running_at,
        last_run_at, last_status, last_error, last_duration_ms, consecutive_failures,
        created_at, updated_at, schedule_kind, schedule_at, schedule_every_ms,
        schedule_anchor_ms, schedule_cron_expr, schedule_tz
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'every', null, ?, null, null, null)`,
    ).run(
      "heartbeat-runner",
      60_000,
      120_000,
      1,
      "2026-04-19T12:01:00.000Z",
      null,
      "2026-04-19T12:00:00.000Z",
      "ok",
      null,
      150,
      0,
      "2026-04-19T12:00:00.000Z",
      "2026-04-19T12:00:00.000Z",
      60_000,
    );
  });

  afterAll(async () => {
    await env.close();
  });

  it("GET /v1/status returns hub summary for authenticated callers", async () => {
    const res = await fetch(`${env.baseUrl}/v1/status`, {
      headers: authHeaders(accessToken),
    });
    const json = await res.json() as {
      ok: boolean;
      data: {
        version: string;
        uptime: number;
        activeSessions: number;
        runningJobs: number;
        connectedSatellites: number;
      };
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.data.version).toBe("string");
    expect(json.data.activeSessions).toBe(1);
    expect(json.data.runningJobs).toBe(0);
    expect(json.data.connectedSatellites).toBe(0);
  });

  it("GET /v1/jobs returns scheduler-backed job summaries", async () => {
    const res = await fetch(`${env.baseUrl}/v1/jobs`, {
      headers: authHeaders(accessToken),
    });
    const json = await res.json() as {
      ok: boolean;
      data: Array<{
        jobId: string;
        status: string;
        lastRunAt: string | null;
        nextRunAt: string | null;
      }>;
    };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([
      {
        jobId: "heartbeat-runner",
        name: "heartbeat-runner",
        status: "scheduled",
        lastRunAt: "2026-04-19T12:00:00.000Z",
        nextRunAt: "2026-04-19T12:01:00.000Z",
      },
    ]);
  });
});
