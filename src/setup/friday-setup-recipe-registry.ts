/**
 * Setup Recipe Registry — Manages available setup recipes.
 *
 * @module setup
 */

import type {
  FridaySetupRecipe,
  FridaySetupRecipeListFilters,
  FridaySetupRecipeRegistry,
} from "./friday-setup.types.js";

// ─── Factory ───

export function createFridaySetupRecipeRegistry(): FridaySetupRecipeRegistry {
  const recipes = new Map<string, FridaySetupRecipe>();

  return {
    register(recipe: FridaySetupRecipe): void {
      recipes.set(recipe.id, recipe);
    },

    get(recipeId: string): FridaySetupRecipe | null {
      return recipes.get(recipeId) ?? null;
    },

    list(filters?: FridaySetupRecipeListFilters): readonly FridaySetupRecipe[] {
      let result = Array.from(recipes.values());
      if (filters?.category) {
        result = result.filter((r) => r.category === filters.category);
      }
      if (filters?.targetService) {
        result = result.filter((r) => r.targetService === filters.targetService);
      }
      return result;
    },

    getByTarget(targetService: string): FridaySetupRecipe | null {
      for (const recipe of recipes.values()) {
        if (recipe.targetService === targetService) return recipe;
      }
      return null;
    },
  };
}
