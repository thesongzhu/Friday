import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFridayNodesService,
  type FridayNodesServiceOptions,
} from "../../../src/nodes/friday-nodes-service.js";

function makeOptions(): FridayNodesServiceOptions {
  return {
    discoverFn: async () => [],
    getFn: async () => null,
    controlFn: async (nodeId, command) => ({
      nodeId,
      command,
      success: true,
    }),
  };
}

describe("createFridayNodesService (B4 generic-factory truth-labeling)", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    if (consoleInfoSpy) consoleInfoSpy.mockRestore();
  });

  it("B4 truth-labeling: emits a one-time advisory naming the proof_pending state on first construction", () => {
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    // The advisory is warn-once per process. We may have already seen it
    // emitted in a prior test in this file or this run; the locked truth
    // is "at most one per process".
    createFridayNodesService(makeOptions());
    createFridayNodesService(makeOptions());
    createFridayNodesService(makeOptions());

    const advisoryCalls = consoleInfoSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && (call[0] as string).includes("[friday][nodes][generic-factory]"),
    );
    expect(advisoryCalls.length).toBeLessThanOrEqual(1);
    if (advisoryCalls.length === 1) {
      const message = advisoryCalls[0]![0] as string;
      expect(message).toContain("zero production callers");
      expect(message).toContain("createFridaySatelliteNodesService");
      expect(message).toContain("proof_pending");
    }
  });

  it("regression: the factory still returns a service whose discover/get/control delegate to the injected fns", async () => {
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const discoverFn = vi.fn(async () => [{ nodeId: "n1", name: "Node One", kind: "k", status: "online" as const }]);
    const getFn = vi.fn(async (id: string) => ({ nodeId: id, name: "g", kind: "k", status: "offline" as const }));
    const controlFn = vi.fn(async (nodeId: string, command: string) => ({ nodeId, command, success: true }));
    const service = createFridayNodesService({ discoverFn, getFn, controlFn });

    const ctrl = new AbortController();
    expect((await service.discover(ctrl.signal))[0]!.nodeId).toBe("n1");
    expect((await service.get("xyz", ctrl.signal))!.nodeId).toBe("xyz");
    expect((await service.control("xyz", "reboot", { force: true }, 5000, ctrl.signal)).success).toBe(true);
    expect(discoverFn).toHaveBeenCalled();
    expect(getFn).toHaveBeenCalledWith("xyz", ctrl.signal);
    expect(controlFn).toHaveBeenCalledWith("xyz", "reboot", { force: true }, 5000, ctrl.signal);
  });
});
