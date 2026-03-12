import { describe, it, expect } from "vitest";
import { createFridayAgentSelfFixService } from "#agent";
import type { FridayAgentTestResult } from "#agent";

// ─── Helpers ───

function makePassingResult(overrides?: Partial<FridayAgentTestResult>): FridayAgentTestResult {
  return {
    strategy: "syntax",
    passed: true,
    errors: [],
    durationMs: 10,
    ...overrides,
  };
}

function makeFailingResult(overrides?: Partial<FridayAgentTestResult>): FridayAgentTestResult {
  return {
    strategy: "syntax",
    passed: false,
    errors: [{ message: "Unexpected token", file: "/tmp/app.js", line: 5, severity: "error" }],
    durationMs: 15,
    ...overrides,
  };
}

describe("FridayAgentSelfFixService", () => {
  // ─── All tests pass ───

  it("returns shouldRetry=false when all tests pass", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [makePassingResult()],
      task: "Write a hello world script",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toContain("passed");
  });

  it("returns shouldRetry=false for empty test results", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [],
      task: "Do something",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.shouldRetry).toBe(false);
  });

  // ─── Retry on failure ───

  it("returns shouldRetry=true when tests fail and budget remains", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write a function",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.shouldRetry).toBe(true);
    expect(result.fixPrompt).toBeDefined();
  });

  it("includes original task in fix prompt", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Create a REST API",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.fixPrompt).toContain("Create a REST API");
  });

  it("includes error details in fix prompt", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.fixPrompt).toContain("Unexpected token");
    expect(result.fixPrompt).toContain("/tmp/app.js");
  });

  // ─── Budget exhausted ───

  it("gives up when attempt reaches maxAttempts", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 2,
      maxAttempts: 3,
    });

    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toContain("budget");
  });

  it("gives up on last attempt (maxAttempts=1)", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 0,
      maxAttempts: 1,
    });

    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toContain("budget");
  });

  // ─── Identical errors detection ───

  it("gives up when identical errors are detected between attempts", () => {
    const svc = createFridayAgentSelfFixService();

    // First attempt — should retry
    const first = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 0,
      maxAttempts: 5,
    });
    expect(first.shouldRetry).toBe(true);

    // Second attempt with identical error — should give up
    const second = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 1,
      maxAttempts: 5,
    });
    expect(second.shouldRetry).toBe(false);
    expect(second.reason).toContain("no progress");
  });

  it("retries when errors differ between attempts", () => {
    const svc = createFridayAgentSelfFixService();

    // First attempt
    svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 0,
      maxAttempts: 5,
    });

    // Second attempt with different error
    const second = svc.evaluate({
      testResults: [makeFailingResult({
        errors: [{ message: "Different error", severity: "error" }],
      })],
      task: "Write code",
      attempt: 1,
      maxAttempts: 5,
    });
    expect(second.shouldRetry).toBe(true);
  });

  // ─── Reset ───

  it("reset clears previous error tracking", () => {
    const svc = createFridayAgentSelfFixService();

    // First attempt
    svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 0,
      maxAttempts: 5,
    });

    // Reset
    svc.reset();

    // Same error again — should retry because history was cleared
    const result = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Write code",
      attempt: 0,
      maxAttempts: 5,
    });
    expect(result.shouldRetry).toBe(true);
  });

  // ─── Multiple failure types ───

  it("handles mixed pass/fail results", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [
        makePassingResult(),
        makeFailingResult(),
      ],
      task: "Write code",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.shouldRetry).toBe(true);
    expect(result.fixPrompt).toContain("Unexpected token");
  });

  it("includes errors from multiple failures in fix prompt", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [
        makeFailingResult({
          strategy: "syntax",
          errors: [{ message: "Syntax issue", severity: "error" }],
        }),
        makeFailingResult({
          strategy: "manifest",
          errors: [{ message: "Missing name field", severity: "error" }],
        }),
      ],
      task: "Create a skill",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.fixPrompt).toContain("Syntax issue");
    expect(result.fixPrompt).toContain("Missing name field");
    expect(result.fixPrompt).toContain("[syntax]");
    expect(result.fixPrompt).toContain("[manifest]");
  });

  // ─── Fix prompt structure ───

  it("fix prompt contains task and error sections", () => {
    const svc = createFridayAgentSelfFixService();
    const result = svc.evaluate({
      testResults: [makeFailingResult()],
      task: "Build a calculator",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.fixPrompt).toContain("Original task");
    expect(result.fixPrompt).toContain("Build a calculator");
    expect(result.fixPrompt).toContain("Test failures");
    expect(result.fixPrompt).toContain("Fix the issues");
  });

  // ─── Error ordering for signature ───

  it("treats errors as identical regardless of order", () => {
    const svc = createFridayAgentSelfFixService();

    // First attempt with errors A, B
    svc.evaluate({
      testResults: [makeFailingResult({
        errors: [
          { message: "Error A", severity: "error" },
          { message: "Error B", severity: "error" },
        ],
      })],
      task: "Write code",
      attempt: 0,
      maxAttempts: 5,
    });

    // Second attempt with errors B, A (reversed order)
    const result = svc.evaluate({
      testResults: [makeFailingResult({
        errors: [
          { message: "Error B", severity: "error" },
          { message: "Error A", severity: "error" },
        ],
      })],
      task: "Write code",
      attempt: 1,
      maxAttempts: 5,
    });

    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toContain("no progress");
  });
});
