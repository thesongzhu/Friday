import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { AGENT_OS_NAV_ADVANCED, resolvePageTitle } from "../../../ui/src/lib/routes/agent-os-nav";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function readUiSource(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

const SETUP_PAGE_SRC = readUiSource("ui/src/routes/setup-page.tsx");
const SETTINGS_PAGE_SRC = readUiSource("ui/src/routes/settings-page.tsx");

function hasSecretInputElement(source: string, secretName: string): boolean {
  // True iff there is a JSX <input ...> or <textarea ...> element whose
  // surrounding attribute soup (within ~240 chars) references the named
  // secret. Catches placeholder/value/name/id/aria-label bindings to a
  // runtime secret without flagging mere narrative mentions of the secret.
  const inputElementWindow = /<(?:input|textarea)\b[^>]{0,240}/gi;
  for (const match of source.matchAll(inputElementWindow)) {
    if (match[0].includes(secretName)) return true;
  }
  return false;
}

const FORBIDDEN_PHASE_WORDING: ReadonlyArray<{
  description: string;
  pattern: RegExp;
}> = [
  {
    description: "HTTP-only worker proof being treated as acceptable",
    pattern: /HTTP[- ]only[^\n]{0,80}(accept|allowed|fine|可接受)/i,
  },
  {
    description: "China-Friendly Local Mode provider recommendation entry",
    pattern: /China[- ]Friendly Local Mode|本地中国友好模式/i,
  },
  {
    description: "Friday-hosted user data claim",
    pattern: /(Friday[- ]hosted|Friday 托管)\s*(user data|用户数据)/i,
  },
  {
    description: "overclaim of 17B live cloud certification as passed",
    pattern: /17B[^\n]{0,40}(passed|pass|完成|已通过)/i,
  },
];

describe("Phase 17A — cloud worker setup entrypoints", () => {
  describe("setup wizard (setup-page.tsx)", () => {
    it("exposes the cloud worker setup path from the readiness summary", () => {
      expect(SETUP_PAGE_SRC).toMatch(/data-testid="setup-cloud-worker-advanced"/);
      expect(SETUP_PAGE_SRC).toMatch(/navigate\("\/cloud-workers"\)/);
    });

    it("frames the entrypoint as optional advanced, not a required step", () => {
      expect(SETUP_PAGE_SRC).toMatch(/Optional · Advanced/);
      expect(SETUP_PAGE_SRC).toMatch(/可选 · 高级/);
    });

    it("declares HTTPS and dedicated subdomain requirements honestly", () => {
      expect(SETUP_PAGE_SRC).toMatch(/HTTPS/);
      expect(SETUP_PAGE_SRC).toMatch(/dedicated subdomain|专用子域/);
    });

    it("labels 17A as fixture proof and 17B live certification as blocked_by_env", () => {
      const step5Slice = SETUP_PAGE_SRC.slice(SETUP_PAGE_SRC.indexOf("data-testid=\"setup-cloud-worker-advanced\""));
      expect(step5Slice).toMatch(/17A[^\n]{0,80}fixture/);
      expect(step5Slice).toMatch(/17B[^\n]{0,200}blocked_by_env/);
    });

    it("states ordinary users do not paste FRIDAY_MASTER_KEY or FRIDAY_TOKEN_SECRET", () => {
      expect(SETUP_PAGE_SRC).toMatch(/FRIDAY_MASTER_KEY[\s\S]{0,200}FRIDAY_TOKEN_SECRET/);
      expect(SETUP_PAGE_SRC).toMatch(/(do not paste|never paste|无需手动填写)/);
    });

    it("does not render an input/textarea field bound to FRIDAY_MASTER_KEY or FRIDAY_TOKEN_SECRET", () => {
      expect(hasSecretInputElement(SETUP_PAGE_SRC, "FRIDAY_MASTER_KEY")).toBe(false);
      expect(hasSecretInputElement(SETUP_PAGE_SRC, "FRIDAY_TOKEN_SECRET")).toBe(false);
    });

    it.each(FORBIDDEN_PHASE_WORDING)(
      "does not include forbidden Phase 17 wording in the new section ($description)",
      ({ pattern }) => {
        const slice = SETUP_PAGE_SRC.slice(
          SETUP_PAGE_SRC.indexOf("data-testid=\"setup-cloud-worker-advanced\""),
        );
        expect(slice).not.toMatch(pattern);
      },
    );
  });

  describe("Settings management (settings-page.tsx)", () => {
    it("exposes a Cloud Workers management card", () => {
      expect(SETTINGS_PAGE_SRC).toMatch(/data-testid="settings-cloud-worker-card"/);
      const eyebrowCount = (SETTINGS_PAGE_SRC.match(/"云端 Worker", "Cloud Workers"/g) ?? []).length;
      expect(eyebrowCount).toBeGreaterThanOrEqual(1);
    });

    it("links to the cloud-workers setup surface", () => {
      expect(SETTINGS_PAGE_SRC).toMatch(/to="\/cloud-workers"/);
    });

    it("states no Friday-hosted user data and no long-lived credential handoff", () => {
      const slice = SETTINGS_PAGE_SRC.slice(SETTINGS_PAGE_SRC.indexOf("data-testid=\"settings-cloud-worker-card\""));
      expect(slice).toMatch(/(does not host user data|不托管用户数据)/);
      expect(slice).toMatch(/(long-lived credentials|长期凭证)/);
    });

    it("declares HTTPS and dedicated subdomain requirement", () => {
      const slice = SETTINGS_PAGE_SRC.slice(SETTINGS_PAGE_SRC.indexOf("data-testid=\"settings-cloud-worker-card\""));
      expect(slice).toMatch(/HTTPS/);
      expect(slice).toMatch(/(dedicated subdomain|专用子域)/);
    });

    it("labels 17A fixture proof and 17B live certification blocked_by_env honestly", () => {
      const slice = SETTINGS_PAGE_SRC.slice(SETTINGS_PAGE_SRC.indexOf("data-testid=\"settings-cloud-worker-card\""));
      expect(slice).toMatch(/17A[^\n]{0,80}fixture/);
      expect(slice).toMatch(/17B[^\n]{0,400}blocked_by_env/);
    });

    it("states FRIDAY_MASTER_KEY and FRIDAY_TOKEN_SECRET are internal runtime secrets, not user inputs", () => {
      const slice = SETTINGS_PAGE_SRC.slice(SETTINGS_PAGE_SRC.indexOf("data-testid=\"settings-cloud-worker-card\""));
      expect(slice).toMatch(/FRIDAY_MASTER_KEY[\s\S]{0,200}FRIDAY_TOKEN_SECRET/);
      expect(slice).toMatch(/(internal runtime secrets|内部 runtime 秘钥)/);
      expect(slice).toMatch(/(do not paste|不需要手动填写)/);
    });

    it("does not render an input/textarea field bound to FRIDAY_MASTER_KEY or FRIDAY_TOKEN_SECRET", () => {
      const slice = SETTINGS_PAGE_SRC.slice(SETTINGS_PAGE_SRC.indexOf("data-testid=\"settings-cloud-worker-card\""));
      expect(hasSecretInputElement(slice, "FRIDAY_MASTER_KEY")).toBe(false);
      expect(hasSecretInputElement(slice, "FRIDAY_TOKEN_SECRET")).toBe(false);
    });

    it.each(FORBIDDEN_PHASE_WORDING)(
      "does not include forbidden Phase 17 wording ($description)",
      ({ pattern }) => {
        const slice = SETTINGS_PAGE_SRC.slice(SETTINGS_PAGE_SRC.indexOf("data-testid=\"settings-cloud-worker-card\""));
        expect(slice).not.toMatch(pattern);
      },
    );
  });

  describe("navigation surface", () => {
    it("keeps the cloud-workers entry under Advanced with honest 17A/17B framing", () => {
      const item = AGENT_OS_NAV_ADVANCED.find((nav) => nav.path === "/cloud-workers");
      expect(item).toBeDefined();
      expect(item?.label).toEqual({ zh: "云端 Worker", en: "Cloud Workers" });
      expect(item?.description.en).toMatch(/17A fixture/);
      expect(item?.description.en).toMatch(/17B blocked_by_env/);
    });

    it("resolves /cloud-workers to the Cloud Workers page title", () => {
      expect(resolvePageTitle("/cloud-workers")).toEqual({ zh: "云端 Worker", en: "Cloud Workers" });
    });
  });
});
