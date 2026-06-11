import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../../_helpers/auto-detect-provider-env.js";

// Barrier 5 (companion OS-actuation hardening): the `guide_lens` agent tool and the
// setup assistant reach the live Swift companion daemon via `companionBridge` WITHOUT
// passing through the `executeIntent` retirement guard
// (`TS_RUNTIME_SYSTEM_INTENT_RETIRED`). On the default/production path that is a bypass:
// an agent run could drive overlay draws and a `captureSnapshot` screen-read at the
// daemon even though `executeIntent` is 503. The bootstrap now severs both bypasses —
// `guideLensService` and `setupAssistant` receive the live companion bridge ONLY when the
// same test-only flag (`allowTestOnlySystemIntentExecution === true`) that opens
// `executeIntent` is set; otherwise they receive `undefined` (fail-closed no-op). The
// `systemService` consumer is NOT severed here — it keeps the live bridge and is fenced
// separately by `executeIntent`'s own method-level guard.
//
// This test mocks the THREE leaf factory modules (the barrels re-export them by
// reference, so the mock is picked up through `../<area>/index.js`) and captures the
// `companionBridge` argument each factory actually receives when a full hub is built. It
// discriminates the three-way wiring: gate-off → guideLens/setup undefined,
// systemService live; gate-on → all three live.

const captured = vi.hoisted(() => ({
  guideLensBridge: undefined as unknown,
  setupBridge: undefined as unknown,
  systemBridge: undefined as unknown,
  guideLensCalled: false,
  setupCalled: false,
  systemCalled: false,
}));

vi.mock("../../../src/guide-lens/engine/friday-guide-lens-service.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../../src/guide-lens/engine/friday-guide-lens-service.js");
  return {
    ...actual,
    createFridayGuideLensService: vi.fn((deps: Parameters<typeof actual.createFridayGuideLensService>[0]) => {
      captured.guideLensCalled = true;
      captured.guideLensBridge = deps.companionBridge;
      return actual.createFridayGuideLensService(deps);
    }),
  };
});

vi.mock("../../../src/setup/friday-setup-assistant.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../../src/setup/friday-setup-assistant.js");
  return {
    ...actual,
    createFridaySetupAssistant: vi.fn((deps: Parameters<typeof actual.createFridaySetupAssistant>[0]) => {
      captured.setupCalled = true;
      captured.setupBridge = deps.companionBridge;
      return actual.createFridaySetupAssistant(deps);
    }),
  };
});

vi.mock("../../../src/system/engine/friday-system-service.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../../src/system/engine/friday-system-service.js");
  return {
    ...actual,
    createFridaySystemService: vi.fn((deps: Parameters<typeof actual.createFridaySystemService>[0]) => {
      captured.systemCalled = true;
      captured.systemBridge = deps.companionBridge;
      return actual.createFridaySystemService(deps);
    }),
  };
});

// Imported AFTER the mocks are declared (vi.mock is hoisted above, so the SUT picks up the
// mocked leaf modules through the barrel re-exports).
const { createFridayHub } = await import("#hub");
type FridayHub = Awaited<ReturnType<typeof createFridayHub>>;

describe("Barrier 5: sever guideLens/setupAssistant companion bypasses", () => {
  let hub: FridayHub | null = null;
  let stateDir: string | null = null;
  let bundledSkillsDir: string | null = null;
  let managedSkillsDir: string | null = null;
  let autoDetectEnvSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;
  const originalSuppression = process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
  const originalTransport = process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;

  beforeEach(() => {
    process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = "1";
    // Use the local in-process companion bridge so the bridge is constructed
    // (non-undefined — proving the gate, not a vacuous undefined-everywhere pass) WITHOUT
    // starting a unix-socket server. FRIDAY_SYSTEM_ENABLED is unset → systemEnabled true →
    // the bridge IS built.
    process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = "in_process";
    autoDetectEnvSnapshot = clearAutoDetectProviderEnv();
    captured.guideLensBridge = undefined;
    captured.setupBridge = undefined;
    captured.systemBridge = undefined;
    captured.guideLensCalled = false;
    captured.setupCalled = false;
    captured.systemCalled = false;
  });

  afterEach(async () => {
    if (originalSuppression === undefined) {
      delete process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS;
    } else {
      process.env.FRIDAY_SUPPRESS_TEST_ENV_SECURITY_WARNINGS = originalSuppression;
    }
    if (originalTransport === undefined) {
      delete process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT;
    } else {
      process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT = originalTransport;
    }
    if (hub) {
      await hub.stop();
      hub = null;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
    bundledSkillsDir = null;
    managedSkillsDir = null;
    if (autoDetectEnvSnapshot) {
      restoreAutoDetectProviderEnv(autoDetectEnvSnapshot);
      autoDetectEnvSnapshot = null;
    }
  });

  async function buildHub(
    overrides: Partial<Parameters<typeof createFridayHub>[0]> = {},
  ): Promise<FridayHub> {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-hub-companion-sever-"));
    bundledSkillsDir = path.join(stateDir, "skills-empty");
    managedSkillsDir = path.join(stateDir, "managed-skills-empty");
    await fs.mkdir(bundledSkillsDir, { recursive: true });
    await fs.mkdir(managedSkillsDir, { recursive: true });
    hub = await createFridayHub({
      skillDirs: [bundledSkillsDir, managedSkillsDir],
      stateDir,
      ...overrides,
    });
    return hub;
  }

  it("gate OFF (prod default): guideLens + setupAssistant get NO live companion bridge; systemService unchanged", async () => {
    // No allowTestOnlySystemIntentExecution → the production default.
    await buildHub();

    // Sanity: all three factories ran AND the live bridge was actually constructed (the
    // systemService consumer received a non-undefined bridge), so an undefined elsewhere is
    // a SEVER, not a vacuous undefined-everywhere pass.
    expect(captured.guideLensCalled).toBe(true);
    expect(captured.setupCalled).toBe(true);
    expect(captured.systemCalled).toBe(true);
    expect(captured.systemBridge).toBeDefined();

    // The two agent-reachable bypasses are severed: no live bridge.
    expect(captured.guideLensBridge).toBeUndefined();
    expect(captured.setupBridge).toBeUndefined();

    // systemService keeps the live bridge (byte-identical to today; fenced separately by
    // executeIntent's own method-level guard). The two severed consumers did NOT receive
    // that live instance.
    expect(captured.guideLensBridge).not.toBe(captured.systemBridge);
    expect(captured.setupBridge).not.toBe(captured.systemBridge);
  });

  it("gate ON (test-only flag): all three consumers receive the SAME live companion bridge", async () => {
    await buildHub({ allowTestOnlySystemIntentExecution: true });

    expect(captured.guideLensCalled).toBe(true);
    expect(captured.setupCalled).toBe(true);
    expect(captured.systemCalled).toBe(true);

    // The live bridge is present and is the SAME instance handed to systemService — the
    // test-only escape hatch restores the legacy wiring for all three.
    expect(captured.systemBridge).toBeDefined();
    expect(captured.guideLensBridge).toBe(captured.systemBridge);
    expect(captured.setupBridge).toBe(captured.systemBridge);
  });
});
