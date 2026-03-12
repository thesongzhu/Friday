import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";

import { createFridayObservabilityApiService } from "../../../../src/observability/services/friday-observability-api-service.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-03-07T12:00:00.000Z";

describe("createFridayObservabilityApiService", () => {
  const allocatedDbs: Array<ReturnType<typeof createTestDb>> = [];

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()?.close();
    }
  });

  function createService() {
    const db = createTestDb();
    allocatedDbs.push(db);
    return createFridayObservabilityApiService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
  }

  it("exposes overview and time-series data for assistant events", async () => {
    const service = createService();

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
    expect(series.series.metricName).toBe("friday.uix.intents.total");
    expect(series.series.points.some((point) => point.value > 0)).toBe(true);
  });

  it("raises a built-in alert for repeated self-healing failures", () => {
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

    const alerts = service.routes.alerts.list({});
    expect(alerts.items.length).toBeGreaterThanOrEqual(1);
    expect(alerts.items[0]?.ruleId).toBe("builtin-self-healing-repeat-failures");
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

    expect(overview.overview.audit.totalEntries).toBeGreaterThanOrEqual(1);
    expect(traces.items.some((trace) => trace.name.includes("agent-loop"))).toBe(true);
    expect(audit.items.some((entry) => entry.description.includes("Agent loop"))).toBe(true);
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
});
