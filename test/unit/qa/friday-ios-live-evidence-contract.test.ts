import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../../..");

function read(relativePath: string) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("Friday iOS live evidence contract", () => {
  it("binds mobile pet proof metadata to the v9 operator override instead of stale retroLcd", () => {
    const buildSim = read("apps/friday-ios/build-sim.sh");
    const contract = read("scripts/ops/check-friday-ios-live-evidence-contract.mjs");

    expect(buildSim).toContain('"pet_style": "v9InteractiveDog"');
    expect(buildSim).toContain('"pet_style_source": "operator-override-2026-06-29"');
    expect(buildSim).toContain('"stale_saved_pet_style": "retroLcd"');
    expect(buildSim).toContain('"pet_reference": "pet-anim-v9-reference.html"');
    expect(buildSim).not.toContain('"pet_style": "retroLcd"');

    expect(contract).toContain('"pet_style": "v9InteractiveDog"');
    expect(contract).toContain('"pet_style_source": "operator-override-2026-06-29"');
    expect(contract).not.toContain('"pet_style": "retroLcd"');
  });
});
