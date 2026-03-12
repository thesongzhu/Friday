import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Canonical Stack Exports ───

import {
  FRIDAY_CONVERTER_PIPELINE_STATES,
  FRIDAY_CONVERTER_PIPELINE_TRANSITIONS,
  FRIDAY_CONVERTER_PIPELINE_TERMINAL_STATES,
  FRIDAY_CONVERTER_QUALITY_GATES,
  FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES,
  FRIDAY_CANONICAL_CONVERTER_STACK,
} from "#skills/converter";

import type {
  FridayConverterPipelineState,
  FridayConverterPipelineStage,
  FridayConverterQualityGate,
  FridayConverterQualityCheck,
  FridayConverterQualityResult,
  FridayConverterDiagnosticSeverity,
  FridayConverterDiagnostic,
  FridayConverterPipelineRecord,
  FridayConverterStack,
  FridaySkillSourceFormat,
  FridaySkillConverter,
} from "#skills/converter";

// ─── Pipeline State Machine Tests ───

describe("Converter Pipeline State Machine (C-006)", () => {
  it("defines 8 pipeline states", () => {
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toHaveLength(8);
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("pending");
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("detecting");
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("converting");
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("validating");
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("installing");
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("completed");
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("failed");
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toContain("cancelled");
  });

  it("terminal states have no transitions", () => {
    for (const state of FRIDAY_CONVERTER_PIPELINE_TERMINAL_STATES) {
      expect(FRIDAY_CONVERTER_PIPELINE_TRANSITIONS[state]).toEqual([]);
    }
  });

  it("terminal states match expected set", () => {
    expect(FRIDAY_CONVERTER_PIPELINE_TERMINAL_STATES).toEqual(
      expect.arrayContaining(["completed", "failed", "cancelled"]),
    );
  });

  it("all states have transition entries", () => {
    for (const state of FRIDAY_CONVERTER_PIPELINE_STATES) {
      expect(FRIDAY_CONVERTER_PIPELINE_TRANSITIONS).toHaveProperty(state);
    }
  });

  it("non-terminal states can transition to failed/cancelled", () => {
    const nonTerminal = FRIDAY_CONVERTER_PIPELINE_STATES.filter(
      (s) => !FRIDAY_CONVERTER_PIPELINE_TERMINAL_STATES.includes(s),
    );
    for (const state of nonTerminal) {
      expect(FRIDAY_CONVERTER_PIPELINE_TRANSITIONS[state]).toContain("failed");
      expect(FRIDAY_CONVERTER_PIPELINE_TRANSITIONS[state]).toContain("cancelled");
    }
  });

  it("pending transitions to detecting", () => {
    expect(FRIDAY_CONVERTER_PIPELINE_TRANSITIONS.pending).toContain("detecting");
  });

  it("pipeline follows linear progression", () => {
    const progression = ["pending", "detecting", "converting", "validating", "installing", "completed"] as const;
    for (let i = 0; i < progression.length - 1; i++) {
      const current = progression[i];
      const next = progression[i + 1];
      expect(FRIDAY_CONVERTER_PIPELINE_TRANSITIONS[current]).toContain(next);
    }
  });
});

// ─── Quality Gates Tests ───

describe("Converter Quality Gates (C-006)", () => {
  it("defines 3 quality gate types", () => {
    expect(FRIDAY_CONVERTER_QUALITY_GATES).toHaveLength(3);
    expect(FRIDAY_CONVERTER_QUALITY_GATES).toContain("schema_validation");
    expect(FRIDAY_CONVERTER_QUALITY_GATES).toContain("manifest_completeness");
    expect(FRIDAY_CONVERTER_QUALITY_GATES).toContain("file_integrity");
  });
});

// ─── Diagnostics Tests ───

describe("Converter Diagnostics (C-006)", () => {
  it("defines 4 severity levels", () => {
    expect(FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES).toHaveLength(4);
    expect(FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES).toContain("info");
    expect(FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES).toContain("warning");
    expect(FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES).toContain("error");
    expect(FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES).toContain("fatal");
  });
});

// ─── Canonical Stack Guard ───

describe("Canonical Converter Stack (C-006)", () => {
  it("skills is the canonical production stack", () => {
    expect(FRIDAY_CANONICAL_CONVERTER_STACK).toBe("skills");
  });
});

// ─── Convergence Guard: Deprecated Compat Stack Retired ───

describe("Convergence Guard (C-006)", () => {
  const DEPRECATED_STACK = join(
    process.cwd(),
    "src",
    "converter",
  );

  it("deprecated src/converter/ has been fully retired", () => {
    expect(existsSync(DEPRECATED_STACK)).toBe(false);
  });

  it("no production code imports from src/converter/ (convergence guard)", () => {
    // This test scans the src/ directory for imports from the deprecated stack.
    // It ensures no new code accidentally depends on the old module.
    const violations: string[] = [];
    const srcDir = join(process.cwd(), "src");

    function scanDir(dir: string) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        // Skip the deprecated stack itself
        if (fullPath.startsWith(DEPRECATED_STACK)) continue;

        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          const content = readFileSync(fullPath, "utf-8");
          if (importsDeprecatedConverter(fullPath, content)) {
            violations.push(fullPath);
          }
        }
      }
    }

    scanDir(srcDir);
    expect(violations).toEqual([]);
  });

  it("canonical src/skills/converter/ exports all 8 source formats", () => {
    // Verify that the canonical stack covers all known source formats
    const expectedFormats: FridaySkillSourceFormat[] = [
      "friday-package",
      "clawdbot-skill-md",
      "n8n-node",
      "openai-gpt-action",
      "code-repo",
      "undocumented-api",
      "desktop-recording",
      "unknown",
    ];

    // We verify by checking that each format string is a valid type assignment
    for (const format of expectedFormats) {
      const f: FridaySkillSourceFormat = format;
      expect(f).toBe(format);
    }
  });

  it("pipeline types are exported from canonical stack", () => {
    // These types remain available from the canonical src/skills/converter/ barrel.
    expect(FRIDAY_CONVERTER_PIPELINE_STATES).toBeDefined();
    expect(FRIDAY_CONVERTER_PIPELINE_TRANSITIONS).toBeDefined();
    expect(FRIDAY_CONVERTER_QUALITY_GATES).toBeDefined();
    expect(FRIDAY_CONVERTER_DIAGNOSTIC_SEVERITIES).toBeDefined();
    expect(FRIDAY_CANONICAL_CONVERTER_STACK).toBeDefined();
  });
});

const IMPORT_SPECIFIER_PATTERNS = [
  /from\s+["']([^"']+)["']/g,
  /import\s+["']([^"']+)["']/g,
];

function importsDeprecatedConverter(importerPath: string, content: string): boolean {
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1]!;
      if (specifier === "#converter") {
        return true;
      }
      if (specifier.startsWith("#")) {
        continue;
      }
      const resolved = resolve(dirname(importerPath), specifier);
      if (resolved.startsWith(DEPRECATED_STACK_ROOT)) {
        return true;
      }
    }
  }
  return false;
}

const DEPRECATED_STACK_ROOT = join(process.cwd(), "src", "converter");

// ─── Type Compilation Tests ───

describe("Pipeline Type Compilation (C-006)", () => {
  it("FridayConverterPipelineRecord compiles with all required fields", () => {
    const record: FridayConverterPipelineRecord = {
      id: "pipe-1",
      state: "completed",
      currentStage: null,
      stages: [],
      qualityResult: {
        checks: [
          { gate: "schema_validation", passed: true, message: "ok" },
        ],
        allPassed: true,
        checkedAt: "2026-01-01T00:00:00Z",
      },
      diagnostics: [
        {
          severity: "info",
          code: "CONV_001",
          message: "Conversion started",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      errorMessage: null,
      errorCode: null,
      sourceFormat: "desktop-recording",
      converterId: "desktop-recording",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    };

    expect(record.state).toBe("completed");
    expect(record.qualityResult?.allPassed).toBe(true);
    expect(record.diagnostics).toHaveLength(1);
  });

  it("FridayConverterPipelineStage compiles with all fields", () => {
    const stage: FridayConverterPipelineStage = {
      name: "converting",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      errorMessage: null,
    };
    expect(stage.status).toBe("completed");
  });

  it("FridayConverterStack type compiles with valid values", () => {
    const skills: FridayConverterStack = "skills";
    const universal: FridayConverterStack = "universal";
    expect(skills).toBe("skills");
    expect(universal).toBe("universal");
  });
});
