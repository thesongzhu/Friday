import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 Memory Passport screen contract", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("keeps Memory Passport on the authenticated desktop memory route", () => {
    const routerSource = read("ui/src/router.tsx");
    const navSource = read("ui/src/lib/routes/agent-os-nav.ts");

    expect(routerSource).toContain('path: "memory"');
    expect(routerSource).toContain("<MemoryPage />");
    expect(navSource).toContain('path: "/memory"');
    expect(navSource).toContain("Memory Passport");
  });

  it("renders passport identity, authority, and candidate-review boundaries", () => {
    const source = read("ui/src/routes/memory-page.tsx");

    expect(source).toContain('data-ui-screen="desktop-memory-passport"');
    expect(source).toContain('data-ui-component="memory-passport-header"');
    expect(source).toContain('data-ui-component="memory-authority-boundaries"');
    expect(source).toContain('data-ui-component="memory-candidate-review"');
    expect(source).toContain("memory_review_no_silent_write_decide_candidate");
    expect(source).toContain("no silent memory write");
    expect(source).toContain("candidate_review_only");
    expect(source).toContain("NO-GO");
  });

  it("keeps recall, revoke, export, and stored-memory surfaces truth-labelled", () => {
    const source = read("ui/src/routes/memory-page.tsx");

    expect(source).toContain('data-ui-component="memory-passport-search"');
    expect(source).toContain('data-ui-component="memory-passport-store"');
    expect(source).toContain('data-ui-component="memory-passport-revoke"');
    expect(source).toContain('data-ui-component="memory-passport-export"');
    expect(source).toContain("stored memory !== automatic recall PASS");
    expect(source).toContain("runtime recall proof required");
  });
});
