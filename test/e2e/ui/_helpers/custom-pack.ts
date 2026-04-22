import type { FridayMockBrowserE2eEnv } from "./browser-env-mock.js";

export interface BrowserE2eCustomPackInput {
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  skillIds: string[];
  entryPrompts: string[];
}

export const DEFAULT_BROWSER_CUSTOM_PACK: BrowserE2eCustomPackInput = {
  name: "Browser E2E Ops",
  nameEn: "Browser E2E Ops",
  description: "Track one custom operator workflow with live runs and direct chat handoff.",
  descriptionEn: "Track one custom operator workflow with live runs and direct chat handoff.",
  skillIds: ["browser-qa-report"],
  entryPrompts: [
    "Review the current operator surface and tell me the next action to take.",
  ],
};

function buildCustomPackId(name: string, index: number): string {
  return `custom-${index}-${name.replace(/\s+/g, "-").toLowerCase()}`;
}

export const DEFAULT_BROWSER_CUSTOM_PACK_ID = buildCustomPackId(DEFAULT_BROWSER_CUSTOM_PACK.name, 0);

export async function seedCustomPacks(
  env: FridayMockBrowserE2eEnv,
  inputs: BrowserE2eCustomPackInput[],
): Promise<string[]> {
  const response = await env.apiFetch<unknown>("PUT", "/v1/uix/preferences", {
    preferences: [
      {
        category: "uix",
        key: "packs.customInputs",
        value: inputs,
      },
    ],
  });
  if (response.status !== 200 || !response.json.ok) {
    throw new Error(`Failed to seed custom packs: ${JSON.stringify(response.json)}`);
  }
  return inputs.map((input, index) => buildCustomPackId(input.name, index));
}

export async function seedDefaultCustomPack(env: FridayMockBrowserE2eEnv): Promise<string> {
  const [packId] = await seedCustomPacks(env, [DEFAULT_BROWSER_CUSTOM_PACK]);
  if (!packId) {
    throw new Error("Default browser E2E custom pack did not produce an id");
  }
  return packId;
}
