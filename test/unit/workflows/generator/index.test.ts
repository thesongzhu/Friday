import { describe, it, expect } from "vitest";

describe("Workflow generator barrel exports", () => {
  it("exports model types", async () => {
    const mod = await import("#workflows");
    // Type exports are compile-time only, but we can verify the factory exports exist
    expect(mod.createFridayWorkflowGeneratorService).toBeTypeOf("function");
    expect(mod.createFridayGeneratedWorkflowValidator).toBeTypeOf("function");
    expect(mod.createFridayWorkflowGenerationSessionRepository).toBeTypeOf("function");
  });

  it("exports prompt builders", async () => {
    const mod = await import("#workflows");
    expect(mod.buildWorkflowRequirementsPrompt).toBeTypeOf("function");
    expect(mod.buildWorkflowSpecPrompt).toBeTypeOf("function");
    expect(mod.buildWorkflowVisualLayoutPrompt).toBeTypeOf("function");
    expect(mod.buildWorkflowTestsPrompt).toBeTypeOf("function");
  });
});
