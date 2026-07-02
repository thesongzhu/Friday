import { describe, expect, it, vi } from "vitest";

import { createFridayRealtimeEventBus } from "#api";
import type { FridayRealtimeEventEnvelope } from "#api";

describe("FridayRealtimeEventBus redaction", () => {
  it("redacts secret-shaped content before fallback persistence and listeners", () => {
    const persisted: FridayRealtimeEventEnvelope[] = [];
    const received: FridayRealtimeEventEnvelope[] = [];
    const bus = createFridayRealtimeEventBus({
      idGenerator: vi.fn(() => "evt-bus-1"),
      nowIso: () => "2026-02-25T12:00:00.000Z",
      persistEvent: (envelope) => persisted.push(envelope),
    });
    bus.subscribe((envelope) => received.push(envelope));

    const envelope = bus.publish("workflow:run-1", "workflow.run.failed", {
      runId: "run-1",
      error: {
        code: "NODE_EXECUTION_FAILED",
        message:
          "tool stderr included Authorization: Bearer sk-a5-event-bus-canary " + // pragma: allowlist secret
          "github_pat_A5FineGrainedCanary_1234567890abcdef " + // pragma: allowlist secret
          "eyJhbGciOiJIUzI1NiJ9.e30.aaaaaaaaaaaaaaaa " + // pragma: allowlist secret
          "token=a5baretokenvalue123 password=a5passwordvalue123 " +
          'OPENAI_API_KEY=a5openaiassignment123 SLACK_BOT_TOKEN=xoxb-a5slackassignment123 AWS_SECRET_ACCESS_KEY=a5awsassignment123 api_key="a5quotedassignment123" "access_token": "a5jsonassignment123" ' + // pragma: allowlist secret
          "-----BEGIN PGP PRIVATE KEY BLOCK-----\na5-private-key-material\n-----END PGP PRIVATE KEY BLOCK-----", // pragma: allowlist secret
      },
    });

    for (const payload of [envelope.payload, persisted[0].payload, received[0].payload]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("sk-a5-event-bus-canary");
      expect(serialized).not.toContain("github_pat_A5FineGrainedCanary_1234567890abcdef"); // pragma: allowlist secret
      expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9.e30.aaaaaaaaaaaaaaaa"); // pragma: allowlist secret
      expect(serialized).not.toContain("a5baretokenvalue123");
      expect(serialized).not.toContain("a5passwordvalue123");
      expect(serialized).not.toContain("a5openaiassignment123");
      expect(serialized).not.toContain("xoxb-a5slackassignment123");
      expect(serialized).not.toContain("a5awsassignment123");
      expect(serialized).not.toContain("a5quotedassignment123");
      expect(serialized).not.toContain("a5jsonassignment123");
      expect(serialized).not.toContain("a5-private-key-material");
      expect(serialized).toContain("[REDACTED]");
    }
  });
});
