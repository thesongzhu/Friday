import { describe, it, expect } from "vitest";
import { createFridaySetupRecipeRegistry } from "../../../src/setup/friday-setup-recipe-registry.js";
import { FRIDAY_BUILTIN_RECIPES } from "../../../src/setup/recipes/friday-setup-builtin-recipes.js";
import type { FridaySetupRecipe } from "../../../src/setup/friday-setup.types.js";

function makeRecipe(overrides?: Partial<FridaySetupRecipe>): FridaySetupRecipe {
  return {
    id: "test-recipe",
    name: "Test Recipe",
    description: "A test recipe",
    category: "channel",
    version: "1.0.0",
    targetService: "test",
    prerequisites: [],
    steps: [],
    outputs: [],
    ...overrides,
  };
}

describe("FridaySetupRecipeRegistry", () => {
  describe("register", () => {
    it("should register a recipe", () => {
      const registry = createFridaySetupRecipeRegistry();
      const recipe = makeRecipe();
      registry.register(recipe);
      expect(registry.get("test-recipe")).toEqual(recipe);
    });

    it("should overwrite an existing recipe with the same ID", () => {
      const registry = createFridaySetupRecipeRegistry();
      registry.register(makeRecipe({ name: "V1" }));
      registry.register(makeRecipe({ name: "V2" }));
      expect(registry.get("test-recipe")!.name).toBe("V2");
    });
  });

  describe("get", () => {
    it("should return null for unknown recipe", () => {
      const registry = createFridaySetupRecipeRegistry();
      expect(registry.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("should return all registered recipes", () => {
      const registry = createFridaySetupRecipeRegistry();
      registry.register(makeRecipe({ id: "r1" }));
      registry.register(makeRecipe({ id: "r2" }));
      expect(registry.list()).toHaveLength(2);
    });

    it("should filter by category", () => {
      const registry = createFridaySetupRecipeRegistry();
      registry.register(makeRecipe({ id: "r1", category: "channel" }));
      registry.register(makeRecipe({ id: "r2", category: "provider" }));

      expect(registry.list({ category: "channel" })).toHaveLength(1);
      expect(registry.list({ category: "provider" })).toHaveLength(1);
      expect(registry.list({ category: "security" })).toHaveLength(0);
    });

    it("should filter by targetService", () => {
      const registry = createFridaySetupRecipeRegistry();
      registry.register(makeRecipe({ id: "r1", targetService: "discord" }));
      registry.register(makeRecipe({ id: "r2", targetService: "telegram" }));

      expect(registry.list({ targetService: "discord" })).toHaveLength(1);
      expect(registry.list({ targetService: "slack" })).toHaveLength(0);
    });
  });

  describe("getByTarget", () => {
    it("should find recipe by target service", () => {
      const registry = createFridaySetupRecipeRegistry();
      registry.register(makeRecipe({ id: "r1", targetService: "discord" }));
      expect(registry.getByTarget("discord")?.id).toBe("r1");
    });

    it("should return null for unknown target", () => {
      const registry = createFridaySetupRecipeRegistry();
      expect(registry.getByTarget("unknown")).toBeNull();
    });
  });

  describe("built-in recipes", () => {
    it("should register all built-in recipes", () => {
      const registry = createFridaySetupRecipeRegistry();
      for (const recipe of FRIDAY_BUILTIN_RECIPES) {
        registry.register(recipe);
      }
      expect(registry.list().length).toBe(FRIDAY_BUILTIN_RECIPES.length);
    });

    it("should include Discord, Telegram, Slack, OpenAI, Anthropic recipes", () => {
      const targets = FRIDAY_BUILTIN_RECIPES.map((r) => r.targetService);
      expect(targets).toContain("discord");
      expect(targets).toContain("telegram");
      expect(targets).toContain("slack");
      expect(targets).toContain("openai");
      expect(targets).toContain("anthropic");
    });

    it("every recipe should have at least one step", () => {
      for (const recipe of FRIDAY_BUILTIN_RECIPES) {
        expect(recipe.steps.length).toBeGreaterThan(0);
      }
    });

    it("every recipe step should have required fields", () => {
      for (const recipe of FRIDAY_BUILTIN_RECIPES) {
        for (const step of recipe.steps) {
          expect(step.id).toBeTruthy();
          expect(step.instruction).toBeTruthy();
          expect(step.guidance).toBeTruthy();
          expect(step.domain).toBeTruthy();
          expect(step.risk).toBeTruthy();
          expect(typeof step.index).toBe("number");
          expect(typeof step.maxRetries).toBe("number");
        }
      }
    });
  });
});
