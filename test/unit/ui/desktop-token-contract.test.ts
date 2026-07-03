import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const uiSrcRoot = "ui/src";

const readRepoFile = (path: string) => readFileSync(path, "utf8");

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    if (!entry.isFile()) return [];
    if (!/\.(css|tsx?)$/.test(path)) return [];
    return [path];
  });
}

describe("UI-W1 desktop token contract", () => {
  it("exposes the operator-approved served-web token names and locked values", () => {
    const tokens = readRepoFile("ui/src/styles/tokens.css");
    const requiredTokens = new Map([
      ["--app-bg", "#f7f6f2"],
      ["--bg", "#f4f3f0"],
      ["--bg-2", "#eceae6"],
      ["--surface", "#ffffff"],
      ["--surface-2", "#f6f5f2"],
      ["--surface-3", "#efede9"],
      ["--paper", "rgba(255,255,255,.74)"],
      ["--paper-strong", "#ffffff"],
      ["--ink", "#19211e"],
      ["--ink-soft", "#3c4642"],
      ["--muted", "#6c756f"],
      ["--faint", "#97a09a"],
      ["--line", "rgba(26,40,35,.12)"],
      ["--hair", "rgba(26,40,35,.08)"],
      ["--accent", "#0f7d8c"],
      ["--accent-ink", "#0a5662"],
      ["--accent-soft", "rgba(15,125,140,.12)"],
      ["--coral", "#d8634d"],
      ["--coral-soft", "rgba(216,99,77,.13)"],
      ["--ok", "#277a5d"],
      ["--ok-soft", "rgba(39,122,93,.12)"],
      ["--warn", "#a86a1d"],
      ["--warn-soft", "rgba(168,106,29,.13)"],
      ["--danger", "#c2493f"],
      ["--danger-soft", "rgba(194,73,63,.12)"],
      ["--r-xl", "30px"],
      ["--r-lg", "22px"],
      ["--r-md", "15px"],
      ["--r-sm", "11px"],
    ]);

    for (const [name, value] of requiredTokens) {
      const pattern = new RegExp(`${name}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;`);
      expect(tokens, `${name} must equal ${value}`).toMatch(pattern);
    }
  });

  it("removes old Tailwind semantic color families from served web source", () => {
    const bannedPattern = /\b(?:bg|border|text|ring|from|to|via|decoration|outline|shadow)-(?:emerald|amber|red|green|yellow|rose)-\d{2,3}(?:\/\d+)?\b/g;
    const bannedLiteralPattern = /#(?:c77d2e|4f7a5c|128c9e|ed6b61|b87329)\b|rgba\(79,\s*122,\s*92,/gi;
    const files = listSourceFiles(uiSrcRoot);
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) => {
      const source = readRepoFile(file);
      const classHits = [...source.matchAll(bannedPattern)].map((match) => match[0]);
      const literalHits = [...source.matchAll(bannedLiteralPattern)].map((match) => match[0]);
      if (classHits.length === 0 && literalHits.length === 0) return [];
      return `${relative(process.cwd(), file)}: ${[...classHits, ...literalHits].join(", ")}`;
    });

    expect(violations).toEqual([]);
  });

  it("keeps the test scoped to the served web source tree", () => {
    expect(statSync(uiSrcRoot).isDirectory()).toBe(true);
  });
});
