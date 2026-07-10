import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ANDROID_APP = "apps/friday-android/app/src/main/kotlin/com/friday/shell/MainActivity.kt";
const ANDROID_MOCK_THEME = "apps/friday-android/mock/src/main/kotlin/com/friday/mock/Theme.kt";
const ANDROID_MOCK_MAIN = "apps/friday-android/mock/src/main/kotlin/com/friday/mock/MainActivity.kt";

const selectedAndroidTokens = [
  "Color.rgb(15, 125, 140)",
  "Color.rgb(216, 99, 77)",
  "Color.rgb(168, 106, 29)",
  "Color.rgb(39, 122, 93)",
] as const;

const selectedComposeTokens = [
  "Color(0xFF0F7D8C)",
  "Color(0xFFD8634D)",
  "Color(0xFFA86A1D)",
  "Color(0xFF277A5D)",
] as const;

const staleFragments = [
  "Retro-LCD",
  "retro-LCD",
  "pixel cat",
  "pet = Retro LCD",
  "Color.rgb(26, 176, 194)",
  "Color.rgb(242, 115, 91)",
  "Color.rgb(230, 150, 30)",
  "Color(0xFF1AB0C2)",
  "Color(0xFFF2735B)",
  "Color(0xFFE6961E)",
  "Color(0xFF8CF2B2)",
] as const;

describe("UI-W2 Android selected token and v9 dog contract", () => {
  it("keeps the real Android shell on selected design tokens and the v9 dog hero", () => {
    const source = readFileSync(ANDROID_APP, "utf8");

    expect(selectedAndroidTokens.filter((token) => !source.includes(token))).toEqual([]);
    expect(staleFragments.filter((fragment) => source.includes(fragment))).toEqual([]);
    expect(source).toContain("V9DogPet");
    expect(source).toContain("v9 dog");
  });

  it("keeps the Android mock shell on selected design tokens and the v9 dog hero", () => {
    const theme = readFileSync(ANDROID_MOCK_THEME, "utf8");
    const main = readFileSync(ANDROID_MOCK_MAIN, "utf8");
    const corpus = `${theme}\n${main}`;

    expect(selectedComposeTokens.filter((token) => !corpus.includes(token))).toEqual([]);
    expect(staleFragments.filter((fragment) => corpus.includes(fragment))).toEqual([]);
    expect(corpus).toContain("drawV9Dog");
    expect(corpus).toContain("v9 dog");
  });
});
