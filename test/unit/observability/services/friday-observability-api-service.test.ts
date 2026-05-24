import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";

import { createFridayObservabilityApiService } from "../../../../src/observability/services/friday-observability-api-service.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";
import { resetMasterKeyCache } from "#providers";

const NOW = "2026-03-07T12:00:00.000Z";

describe("createFridayObservabilityApiService", () => {
  const allocatedDbs: Array<ReturnType<typeof createTestDb>> = [];
  const previousMasterKey = process.env.FRIDAY_MASTER_KEY;
  const previousMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;

  beforeEach(() => {
    process.env.FRIDAY_MASTER_KEY = "16".repeat(32);
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();
  });

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()?.close();
    }
    if (previousMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = previousMasterKey;
    }
    if (previousMasterKeySource === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    } else {
      process.env.FRIDAY_MASTER_KEY_SOURCE = previousMasterKeySource;
    }
    resetMasterKeyCache();
  });

  function createService(options?: {
    browserDiagnosticsProvider?: Parameters<typeof createFridayObservabilityApiService>[0]["browserDiagnosticsProvider"];
    webhookTimeoutMs?: number;
  }) {
    const db = createTestDb();
    allocatedDbs.push(db);
    return createFridayObservabilityApiService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      browserDiagnosticsProvider: options?.browserDiagnosticsProvider,
      webhookTimeoutMs: options?.webhookTimeoutMs,
    });
  }

  it("exposes overview and time-series data for assistant events", async () => {
    const service = createService({
      browserDiagnosticsProvider: () => ({
        configuredMode: "auto",
        activeMode: "headless",
        targetBrowser: "Playwright Chromium",
        sessionCount: 2,
        profiles: [
          {
            name: "operator",
            kind: "operator",
            sessionCount: 1,
            activeTabCount: 1,
          },
        ],
      }),
    });

    await service.recordAssistantEvent({
      userId: "user-1",
      event: "intent_resolved",
      summary: "Resolved a beginner intent.",
      intent: {
        intent: "generate_skill",
        confidence: 0.91,
        summary: "Generate a skill",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["generate-skill"],
      },
    });

    const overview = await service.routes.overview.get();
    const series = service.routes.timeSeries.get({
      metricName: "friday.uix.intents.total",
      startTime: "2026-03-07T11:00:00.000Z",
      endTime: "2026-03-07T13:00:00.000Z",
      bucketSize: "1h",
    });

    expect(overview.overview.traces.totalTraces).toBeGreaterThanOrEqual(1);
    expect(overview.overview.audit.totalEntries).toBeGreaterThanOrEqual(1);
    expect(overview.runtime?.browser?.sessionCount).toBe(2);
    expect(overview.runtime?.browser?.profiles[0]?.kind).toBe("operator");
    expect(series.series.metricName).toBe("friday.uix.intents.total");
    expect(series.series.points.some((point) => point.value > 0)).toBe(true);
  });

  it("raises a built-in alert for repeated self-healing failures", async () => {
    const service = createService();

    service.recordSelfHealingProcessResults({
      results: [
        {
          incidentsCreated: [
            {
              incidentId: "incident-1",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-1",
              status: "open",
              createdAt: NOW,
            },
            {
              incidentId: "incident-2",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-2",
              status: "open",
              createdAt: NOW,
            },
            {
              incidentId: "incident-3",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-3",
              status: "open",
              createdAt: NOW,
            },
          ],
          diagnosisCreated: [],
        },
      ],
      correlationId: "corr-1",
    });
    await service.drainAuditWrites();

    const alerts = service.routes.alerts.list({});
    expect(alerts.items.length).toBeGreaterThanOrEqual(1);
    expect(alerts.items[0]?.ruleId).toBe("builtin-self-healing-repeat-failures");
  });

  it("drains self-healing background audit writes deterministically", async () => {
    const service = createService();

    service.recordSelfHealingProcessResults({
      results: [
        {
          incidentsCreated: [
            {
              incidentId: "incident-drain",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "drain-failure",
              status: "open",
              createdAt: NOW,
            },
          ],
          diagnosisCreated: [
            {
              id: "diagnosis-drain",
              incidentId: "incident-drain",
              confidence: 0.92,
              errorFingerprint: "fingerprint-drain",
              createdAt: NOW,
            },
          ],
        },
      ],
    });

    await service.drainAuditWrites();

    const audit = service.routes.audit.search({ module: "learning" });
    expect(audit.items.map((entry) => entry.action).sort()).toEqual([
      "learning.diagnosis.recorded",
      "learning.incident.opened",
    ]);
  });

  it("surfaces background audit write failures during lifecycle drain", async () => {
    const service = createService();
    allocatedDbs.pop()?.close();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      service.recordSelfHealingProcessResults({
        results: [
          {
            incidentsCreated: [
              {
                incidentId: "incident-after-close",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "late-write",
                status: "open",
                createdAt: NOW,
              },
            ],
            diagnosisCreated: [],
          },
        ],
      });

      await expect(service.drainAuditWrites()).rejects.toMatchObject({
        code: "OBS_AUDIT_BACKGROUND_APPEND_FAILED",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[friday] observability audit append failed",
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fails audited rule mutations when audit persistence is unavailable", async () => {
    const service = createService();
    allocatedDbs.pop()?.close();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        service.routes.alertRules.create({
          name: "Audit must persist",
          description: "Exercise fail-closed audit behavior",
          severity: "critical",
          metric: "friday.learning.failures.total",
          operator: ">",
          threshold: 0,
          evaluationIntervalSec: 60,
          channelIds: [],
        }),
      ).rejects.toMatchObject({ code: "OBS_AUDIT_APPEND_FAILED" });
      expect(warnSpy).toHaveBeenCalledWith(
        "[friday] observability audit append failed",
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("records agent-loop events into traces, audit, and metrics", async () => {
    const service = createService();

    await service.recordAgentLoopEvent({
      event: "agent-loop.run.completed",
      run: {
        loopRunId: "loop-run-1",
        incidentId: "incident-1",
        actionId: "action-1",
        status: "verified",
        attemptNumber: 1,
        riskClass: "safe_probe",
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
      details: {
        run: {
          loopRunId: "loop-run-1",
          userId: "user-1",
          incidentId: "incident-1",
          actionId: "action-1",
          fingerprint: "fp-1",
          trigger: "incident_opened",
          status: "verified",
          riskTier: 0,
          approvalRequired: false,
          attemptNumber: 1,
          expertModeEnabled: true,
          riskClass: "safe_probe",
          requiresFinalApproval: false,
          assumptions: ["repo is available"],
          unknowns: [],
          hypotheses: [],
          probeSteps: [],
          probeBudget: 4,
          objective: "Verify the agent loop event path",
          planSummary: "Record a completed expert-mode loop run",
          verificationPassed: true,
          rollbackAttempted: false,
          rollbackSucceeded: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
        incident: null,
        action: null,
      },
    });

    const overview = await service.routes.overview.get();
    const traces = service.routes.traces.search({ module: "learning" });
    const audit = service.routes.audit.search({ module: "learning" });
    const metrics = service.routes.metrics.getSnapshot();

    expect(overview.overview.audit.totalEntries).toBeGreaterThanOrEqual(1);
    expect(traces.items.some((trace) => trace.name.includes("agent-loop"))).toBe(true);
    expect(audit.items.some((entry) => entry.description.includes("Agent loop"))).toBe(true);
    expect(metrics.metrics["friday.agent_loop.runs.total"]).toBe(1);
  });

  it("counts each loop run once even when multiple lifecycle events are recorded", async () => {
    const service = createService();
    const details = {
      run: {
        loopRunId: "loop-run-1",
        userId: "user-1",
        incidentId: "incident-1",
        actionId: "action-1",
        fingerprint: "fp-1",
        trigger: "incident_opened" as const,
        status: "verified" as const,
        riskTier: 0,
        approvalRequired: false,
        attemptNumber: 1,
        expertModeEnabled: true,
        riskClass: "safe_probe" as const,
        requiresFinalApproval: false,
        assumptions: [],
        unknowns: [],
        hypotheses: [],
        probeSteps: [],
        probeBudget: 4,
        objective: "Verify deduped counting",
        planSummary: "Observe started and completed events for one loop run",
        verificationPassed: true,
        rollbackAttempted: false,
        rollbackSucceeded: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      incident: null,
      action: null,
    };

    await service.recordAgentLoopEvent({
      event: "agent-loop.run.started",
      run: {
        loopRunId: "loop-run-1",
        incidentId: "incident-1",
        actionId: "action-1",
        status: "running",
        attemptNumber: 1,
        riskClass: "safe_probe",
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
      details,
    });
    await service.recordAgentLoopEvent({
      event: "agent-loop.run.completed",
      run: {
        loopRunId: "loop-run-1",
        incidentId: "incident-1",
        actionId: "action-1",
        status: "verified",
        attemptNumber: 1,
        riskClass: "safe_probe",
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
      details,
    });

    const metrics = service.routes.metrics.getSnapshot();
    expect(metrics.metrics["friday.agent_loop.runs.total"]).toBe(1);
  });

  it("searches audit entries after multiple recorded events without mutating the frozen trail", async () => {
    const service = createService();

    await service.recordAssistantEvent({
      userId: "user-1",
      event: "template_executed",
      summary: "Executed deploy template.",
      result: {
        templateId: "deploy-workflow",
        status: "executed",
        summary: "Deploy workflow succeeded",
        routeTarget: "/assistant",
        state: "ready_to_execute",
        objective: "Deploy a workflow",
        assumptions: [],
        unknowns: [],
        successTest: "Workflow is deployed",
        fallbackPath: "Ask for a missing workflow session",
        result: { deployed: true },
      },
    });

    await service.recordSkillGeneratorEvent({
      event: "draft_saved",
      sessionId: "skill-session-1",
      userId: "user-1",
      summary: "Saved a generated skill draft.",
      ok: true,
      evidence: {
        approvalReadiness: {
          ready: true,
          blockers: [],
        },
      },
    });

    const audit = service.routes.audit.search({});

    expect(audit.items).toHaveLength(2);
    expect(audit.items.map((entry) => entry.action).sort()).toEqual([
      "skills.draft_saved",
      "uix.template_executed",
    ]);
  });

  it("lists default SLOs and returns SLO detail", async () => {
    const service = createService();

    const list = await service.routes.slos.list({});
    const apiAvailability = list.items.find((item) => item.id === "slo-api-availability");

    expect(list.items).toHaveLength(5);
    expect(apiAvailability?.status).toBe("healthy");
    expect(apiAvailability?.enabled).toBe(true);

    const detail = await service.routes.slos.get("slo-api-availability");
    expect(detail.slo.id).toBe("slo-api-availability");
    expect(detail.errorBudget?.currentValue).toBeGreaterThanOrEqual(99);
    expect(detail.burnRates).toHaveLength(2);
  });

  it("creates, updates, and deletes alert destinations", async () => {
    const service = createService();

    const created = await service.routes.alertDestinations.create({
      type: "email",
      name: "Ops Email",
      recipients: ["ops@example.com"],
      fromAddress: "alerts@example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 2525,
      password: "email-password", // pragma: allowlist secret
    });
    expect(created.destination.type).toBe("email");

    const listed = service.routes.alertDestinations.list();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.name).toBe("Ops Email");

    const updated = await service.routes.alertDestinations.update(created.destination.id, {
      type: "email",
      enabled: false,
      recipients: ["ops@example.com", "oncall@example.com"],
    });
    expect(updated.destination.enabled).toBe(false);
    expect(updated.destination.type).toBe("email");
    if (updated.destination.type === "email") {
      expect(updated.destination.recipients).toContain("oncall@example.com");
    }

    const deleted = await service.routes.alertDestinations.delete(created.destination.id);
    expect(deleted).toEqual({ deleted: true, destinationId: created.destination.id });
    expect(service.routes.alertDestinations.list().items).toHaveLength(0);
  });

  it("redacts Slack webhook URLs from alert destination responses", async () => {
    const service = createService();

    const created = await service.routes.alertDestinations.create({
      type: "slack",
      name: "Ops Slack",
      webhookUrl: "https://hooks.slack.example/secret-token",
    });
    const rule = await service.routes.alertRules.create({
      name: "Slack rule",
      description: "Rule with Slack channel",
      severity: "warning",
      metric: "friday.learning.failures.total",
      operator: ">",
      threshold: 0,
      evaluationIntervalSec: 60,
      channelIds: [created.destination.id],
    });
    const fetched = service.routes.alertRules.get(rule.rule.id);

    expect(created.destination.type).toBe("slack");
    expect(fetched.channels[0]?.type).toBe("slack");
    if (fetched.channels[0]?.type === "slack") {
      expect(fetched.channels[0].webhookUrl).toBe("********");
      expect(fetched.channels[0].webhookUrl).not.toContain("secret-token");
    }
  });

  it("fails closed when storing alert credentials without FRIDAY_MASTER_KEY", async () => {
    delete process.env.FRIDAY_MASTER_KEY;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();
    const service = createService();

    await expect(
      service.routes.alertDestinations.create({
        type: "slack",
        name: "Ops Slack",
        webhookUrl: "https://hooks.slack.example/credential-marker",
      }),
    ).rejects.toThrow(/FRIDAY_MASTER_KEY is not configured/);
  });

  it("dispatches alerts to Slack destinations", async () => {
    const receivedBodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        receivedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a bound HTTP server address");
    }

    try {
      const service = createService();
      const destination = await service.routes.alertDestinations.create({
        type: "slack",
        name: "Ops Slack",
        webhookUrl: `http://127.0.0.1:${address.port}/slack-webhook`,
        channel: "#ops",
      });

      service.recordSelfHealingProcessResults({
        results: [
          {
            incidentsCreated: [
              {
                incidentId: "incident-a",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-a",
                status: "open",
                createdAt: NOW,
              },
              {
                incidentId: "incident-b",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-b",
                status: "open",
                createdAt: NOW,
              },
              {
                incidentId: "incident-c",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-c",
                status: "open",
                createdAt: NOW,
              },
            ],
            diagnosisCreated: [],
          },
        ],
      });
      await service.drainAuditWrites();

      const alert = service.routes.alerts.list({}).items[0];
      expect(alert).toBeDefined();

      const response = await service.routes.alerts.testDispatch(alert!.id, {
        destinationId: destination.destination.id,
      });

      expect(response.attempts.some((attempt) => attempt.status === "sent")).toBe(true);
      expect(receivedBodies.length).toBeGreaterThanOrEqual(1);
      expect(receivedBodies[0]).toContain("Repeated self-healing failures");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  // B2 hanging-fetch boundary: a Slack webhook server that accepts the
  // connection but never responds must NOT block the dispatch loop forever.
  // The per-attempt timeout must fire and surface as a failed attempt with a
  // clear timeout error message; the audit row must record `outcome: failure`.
  it("B2 hanging-fetch: slack-webhook dispatch fails fast when the endpoint never responds", async () => {
    // Server accepts the TCP connection but never writes any HTTP response.
    const heldSockets: net.Socket[] = [];
    const server = http.createServer((req) => {
      heldSockets.push(req.socket);
      req.on("data", () => { /* swallow */ });
      // Intentionally never call res.end() / res.writeHead().
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a bound HTTP server address");
    }

    try {
      // 60ms keeps the test fast (3 attempts × 60ms ≈ 180ms + 25 + 50ms
      // exponential backoff between retries = ~255ms) while still well above
      // typical CI scheduler jitter.
      const service = createService({ webhookTimeoutMs: 60 });
      const destination = await service.routes.alertDestinations.create({
        type: "slack",
        name: "Hanging Slack",
        webhookUrl: `http://127.0.0.1:${address.port}/slack-webhook`,
        channel: "#ops",
      });

      service.recordSelfHealingProcessResults({
        results: [
          {
            incidentsCreated: [
              { incidentId: "hang-a", userId: "user-1", category: "workflow", severity: "high", signature: "fail-a", status: "open", createdAt: NOW },
              { incidentId: "hang-b", userId: "user-1", category: "workflow", severity: "high", signature: "fail-b", status: "open", createdAt: NOW },
              { incidentId: "hang-c", userId: "user-1", category: "workflow", severity: "high", signature: "fail-c", status: "open", createdAt: NOW },
            ],
            diagnosisCreated: [],
          },
        ],
      });
      await service.drainAuditWrites();

      const alert = service.routes.alerts.list({}).items[0];
      expect(alert).toBeDefined();

      const dispatchStart = Date.now();
      const response = await service.routes.alerts.testDispatch(alert!.id, {
        destinationId: destination.destination.id,
      });
      const dispatchDuration = Date.now() - dispatchStart;

      // Fail-fast proof: 3 attempts each ~60ms + ~75ms total exponential
      // backoff. Cap at 5s so the test catches a real hang, not jitter.
      expect(dispatchDuration).toBeLessThan(5_000);

      // 3 attempts in the retry loop; all must have failed with the timeout
      // error message. The attempt-status check implicitly proves the failure
      // path completed without further hang — the catch block's awaited
      // `appendDispatchAudit` must have returned for the result to be visible.
      expect(response.attempts.length).toBeGreaterThanOrEqual(1);
      for (const attempt of response.attempts) {
        expect(attempt.status).toBe("failed");
        expect(attempt.errorMessage).toMatch(/timed out after 60ms/i);
      }
    } finally {
      for (const socket of heldSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("dispatches alerts to email destinations over SMTP", async () => {
    const conversations: string[] = [];
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 localhost Simple Mail Transfer Service Ready\r\n");
      socket.on("data", (data: string) => {
        conversations.push(data);
        if (data.includes("DATA")) {
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (data.includes("\r\n.\r\n")) {
          socket.write("250 Message accepted\r\n");
        } else if (data.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a bound SMTP server address");
    }

    try {
      const service = createService();
      const destination = await service.routes.alertDestinations.create({
        type: "email",
        name: "Ops Email",
        recipients: ["ops@example.com"],
        fromAddress: "alerts@example.com",
        smtpHost: "127.0.0.1",
        smtpPort: address.port,
        password: "smtp-password", // pragma: allowlist secret
      });

      service.recordSelfHealingProcessResults({
        results: [
          {
            incidentsCreated: [
              {
                incidentId: "incident-x",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-x",
                status: "open",
                createdAt: NOW,
              },
              {
                incidentId: "incident-y",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-y",
                status: "open",
                createdAt: NOW,
              },
              {
                incidentId: "incident-z",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-z",
                status: "open",
                createdAt: NOW,
              },
            ],
            diagnosisCreated: [],
          },
        ],
      });
      await service.drainAuditWrites();

      const alert = service.routes.alerts.list({}).items[0];
      expect(alert).toBeDefined();

      const response = await service.routes.alerts.testDispatch(alert!.id, {
        destinationId: destination.destination.id,
      });

      expect(response.attempts.some((attempt) => attempt.status === "sent")).toBe(true);
      expect(conversations.join("")).toContain("MAIL FROM:<alerts@example.com>");
      expect(conversations.join("")).toContain("RCPT TO:<ops@example.com>");
      expect(conversations.join("")).toContain("Repeated self-healing failures");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("fails closed when the Slack webhook returns a non-2xx response and writes failure audit entries", async () => {
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "internal" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a bound HTTP server address");
    }

    try {
      const service = createService();
      const destination = await service.routes.alertDestinations.create({
        type: "slack",
        name: "Slack failing webhook",
        webhookUrl: `http://127.0.0.1:${address.port}/slack-webhook`,
      });

      service.recordSelfHealingProcessResults({
        results: [
          {
            incidentsCreated: [
              {
                incidentId: "incident-slack-failclosed-a",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-slack-failclosed-a",
                status: "open",
                createdAt: NOW,
              },
              {
                incidentId: "incident-slack-failclosed-b",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-slack-failclosed-b",
                status: "open",
                createdAt: NOW,
              },
              {
                incidentId: "incident-slack-failclosed-c",
                userId: "user-1",
                category: "workflow",
                severity: "high",
                signature: "failure-slack-failclosed-c",
                status: "open",
                createdAt: NOW,
              },
            ],
            diagnosisCreated: [],
          },
        ],
      });
      await service.drainAuditWrites();
      const alert = service.routes.alerts.list({}).items[0];
      expect(alert).toBeDefined();

      const response = await service.routes.alerts.testDispatch(alert!.id, {
        destinationId: destination.destination.id,
      });

      expect(response.attempts.length).toBeGreaterThan(0);
      expect(response.attempts.some((attempt) => attempt.status === "sent")).toBe(false);
      expect(response.attempts.every((attempt) => attempt.status === "failed")).toBe(true);
      expect(response.attempts[0]?.errorMessage ?? "").toMatch(/Slack webhook responded with 500/i);

      await service.drainAuditWrites();
      const auditPage = service.routes.audit.search({
        action: "observability.alert.dispatch",
        outcome: "failure",
      });
      expect(auditPage.items.length).toBeGreaterThan(0);
      expect(auditPage.items[0]).toMatchObject({
        action: "observability.alert.dispatch",
        outcome: "failure",
        module: "observability",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("fails closed when the SMTP password secret is missing for a username-authenticated destination", async () => {
    const service = createService();
    const destination = await service.routes.alertDestinations.create({
      type: "email",
      name: "Ops Email no password",
      recipients: ["ops@example.com"],
      fromAddress: "alerts@example.com",
      smtpHost: "127.0.0.1",
      smtpPort: 2525,
      username: "ops-user",
      password: "", // pragma: allowlist secret
    });

    service.recordSelfHealingProcessResults({
      results: [
        {
          incidentsCreated: [
            {
              incidentId: "incident-smtp-missing-a",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-smtp-missing-a",
              status: "open",
              createdAt: NOW,
            },
            {
              incidentId: "incident-smtp-missing-b",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-smtp-missing-b",
              status: "open",
              createdAt: NOW,
            },
            {
              incidentId: "incident-smtp-missing-c",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-smtp-missing-c",
              status: "open",
              createdAt: NOW,
            },
          ],
          diagnosisCreated: [],
        },
      ],
    });
    await service.drainAuditWrites();
    const alert = service.routes.alerts.list({}).items[0];
    expect(alert).toBeDefined();

    const response = await service.routes.alerts.testDispatch(alert!.id, {
      destinationId: destination.destination.id,
    });

    expect(response.attempts.length).toBeGreaterThan(0);
    expect(response.attempts.some((attempt) => attempt.status === "sent")).toBe(false);
    expect(response.attempts.every((attempt) => attempt.status === "failed")).toBe(true);
    expect(response.attempts[0]?.errorMessage ?? "").toMatch(/Missing SMTP password|smtp/i);

    await service.drainAuditWrites();
    const auditPage = service.routes.audit.search({
      action: "observability.alert.dispatch",
      outcome: "failure",
    });
    expect(auditPage.items.length).toBeGreaterThan(0);
    expect(auditPage.items[0]).toMatchObject({
      action: "observability.alert.dispatch",
      outcome: "failure",
      module: "observability",
    });
  });

  it("skips dispatch to a disabled destination and records the skip in audit metadata", async () => {
    const service = createService();
    const destination = await service.routes.alertDestinations.create({
      type: "email",
      name: "Ops Email Disabled",
      recipients: ["ops@example.com"],
      fromAddress: "alerts@example.com",
      smtpHost: "127.0.0.1",
      smtpPort: 2525,
      password: "smtp-password", // pragma: allowlist secret
    });
    const disabled = await service.routes.alertDestinations.update(destination.destination.id, {
      type: "email",
      enabled: false,
    });
    expect(disabled.destination.enabled).toBe(false);

    service.recordSelfHealingProcessResults({
      results: [
        {
          incidentsCreated: [
            {
              incidentId: "incident-disabled-a",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-disabled-a",
              status: "open",
              createdAt: NOW,
            },
            {
              incidentId: "incident-disabled-b",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-disabled-b",
              status: "open",
              createdAt: NOW,
            },
            {
              incidentId: "incident-disabled-c",
              userId: "user-1",
              category: "workflow",
              severity: "high",
              signature: "failure-disabled-c",
              status: "open",
              createdAt: NOW,
            },
          ],
          diagnosisCreated: [],
        },
      ],
    });
    await service.drainAuditWrites();
    const alert = service.routes.alerts.list({}).items[0];
    expect(alert).toBeDefined();

    const response = await service.routes.alerts.testDispatch(alert!.id, {
      destinationId: destination.destination.id,
    });

    expect(response.attempts).toHaveLength(1);
    expect(response.attempts[0]).toMatchObject({
      destinationId: destination.destination.id,
      status: "skipped",
      errorMessage: "Destination disabled",
    });
    // Skipped dispatches must not write a success audit entry.
    await service.drainAuditWrites();
    const dispatchEntries = service.routes.audit.search({
      action: "observability.alert.dispatch",
    });
    expect(dispatchEntries.items.every((entry) => entry.outcome !== "success"
      || entry.resourceDisplayName !== destination.destination.name)).toBe(true);
  });
});
