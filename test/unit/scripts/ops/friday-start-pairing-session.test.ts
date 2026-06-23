import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = resolve(repoRoot, "scripts/ops/friday-start-pairing-session.sh");
const source = readFileSync(scriptPath, "utf8");

describe("friday-start-pairing-session.sh", () => {
  it("launches the dark pairing server with a QR manifest output", () => {
    expect(source).toContain("hub_pairing_server");
    expect(source).toContain("--qr-json-out");
    expect(source).toContain("FRIDAY_PAIRING_QR_JSON_OUT");
  });

  it("keeps non-loopback exposure behind an explicit operator env", () => {
    expect(source).toContain("FRIDAY_PAIRING_ALLOW_NON_LOOPBACK");
    expect(source).toContain("--allow-non-loopback");
    expect(source).toContain('ALLOW_NON_LOOPBACK}" = "1"');
    expect(source).toContain('HOST}" = "auto-lan"');
    expect(source).toContain("is_private_ipv4");
  });

  it("does not touch operator signing material or mint grants/passports", () => {
    expect(source).not.toContain("operator-approve.key");
    expect(source).not.toContain("friday-operator-sign");
    expect(source).not.toContain("friday-operator-cli grant");
    expect(source).not.toContain("attach_context_passport_ref");
  });
});
