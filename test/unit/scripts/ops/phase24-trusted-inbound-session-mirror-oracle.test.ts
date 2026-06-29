import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PHASE24_LISTENERS_THAT_ASSERT_SESSION_MESSAGES = [
  "phase24b-discord-trusted-inbound-listener.mjs",
  "phase24c-telegram-trusted-inbound-listener.mjs",
  "phase24d-lark-feishu-trusted-inbound-listener.mjs",
  "phase24e-telegram-workflow-candidate-listener.mjs",
  "phase24f-discord-workflow-candidate-listener.mjs",
  "phase24g-lark-feishu-workflow-candidate-listener.mjs",
];

describe("Phase24 listener session-message proof oracle", () => {
  it.each(PHASE24_LISTENERS_THAT_ASSERT_SESSION_MESSAGES)(
    "%s opts into session mirror writes for the disposable proof harness",
    (filename) => {
      const scriptPath = path.resolve(__dirname, "../../../../scripts/ops", filename);
      const source = fs.readFileSync(scriptPath, "utf8");

      expect(source).toMatch(/waitForUserSessionMirror|waitForCandidateAck/u);
      expect(source).toContain("allowTestOnlySessionExecution: true");
      expect(source).toContain("Production/default hubs keep TS session execution");
    },
  );
});
