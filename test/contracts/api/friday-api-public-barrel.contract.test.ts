import { describe, expect, it } from "vitest";

describe("#api public barrel contract", () => {
  it("does not expose dormant packaging route factories", async () => {
    const mod = await import("#api");
    expect(mod).not.toHaveProperty("createFridayPackagingRoutes");
    expect(mod).not.toHaveProperty("FridayPackagingRoutesDeps");
  });
});
