import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = resolve(repoRoot, "scripts/ops/friday-t3-operator-provision.sh");
const source = readFileSync(scriptPath, "utf8");

describe("friday-t3-operator-provision.sh", () => {
  it("keeps T3 minting behind an explicit operator ceremony acknowledgement", () => {
    expect(source).toContain("FRIDAY_T3_OPERATOR_PROVISION_ACK");
    expect(source).toContain("operator-runs-t3-provisioning");
    expect(source).toContain("STEP");
    expect(source).toContain("grant|passport|both");
  });

  it("uses the operator CLI without reading signing keys or exposing an app mint endpoint", () => {
    expect(source).toContain("friday-operator-approve");
    expect(source).toContain("-p friday-operator-cli");
    expect(source).toContain("passport-mint");
    expect(source).not.toContain("operator-approve.key");
    expect(source).not.toContain("FRIDAY_OPERATOR_APPROVE_KEY");
    expect(source).not.toContain("launchctl");
    expect(source).not.toContain("curl ");
  });

  it("requires explicit grant boundaries and context passport inputs", () => {
    expect(source).toContain("FRIDAY_T3_GRANT_ID");
    expect(source).toContain("FRIDAY_T3_AGENT_ID");
    expect(source).toContain("FRIDAY_T3_RISK_CEILING");
    expect(source).toContain("at least one explicit grant boundary is required");
    expect(source).toContain("FRIDAY_T3_PASSPORT_ID");
    expect(source).toContain("FRIDAY_T3_MISSION_ID");
    expect(source).toContain("FRIDAY_T3_DESTINATION_LANE");
    expect(source).toContain("FRIDAY_T3_ITEMS_JSON");
  });
});
