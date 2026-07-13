import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DIST-NPM-CONSUMER-001 docs-truth regression.
 *
 * Locks in the operator-binding disposition that npm is a
 * developer/build/tooling (non-consumer) surface, while the native Friday.app
 * is the intended consumer release vehicle (not yet publicly released).
 *
 * Guards four properties across all public install/distribution surfaces:
 *  (a) consumer-install guidance does NOT present npm as the install path;
 *  (b) tooling/dev instructions remain present and valid (nothing over-deleted);
 *  (c) no source-only / native-release over-claim strings leak into public docs;
 *  (d) referenced in-repo links and npm-script commands are well-formed.
 */

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

// Canonical, stable relabel markers written into every public surface.
const EN_MARKER = "developer/build/tooling surface";
const EN_NOT_CONSUMER = "not a consumer install path";
const EN_VEHICLE = "The native Friday.app is the consumer release vehicle";
const EN_NOT_RELEASED = "not yet publicly released";
const ZH_MARKER = "面向开发者的构建 / 工具链交付物";
const ZH_NOT_CONSUMER = "不是消费者（普通用户）的安装方式";

const CONSUMER_FACING_DOCS = [
  "README.md",
  "README.zh-CN.md",
  "docs/getting-started.md",
  "docs/public-v1-local-candidate.md",
  "docs/ops/friday-cross-platform-downloads.md",
  "docs/open-source-release-review.md",
  "docs/RELEASE_NOTES_TEMPLATE.md",
];

// Present-tense availability claims that are NOT true yet (Friday.app is not
// publicly released; nothing is signed/notarized/App-Store/Play-Production
// shipped; no Endbar-GO). These must never appear in public docs.
const OVERCLAIM_PATTERNS: RegExp[] = [
  /download (the )?(official|native) friday(\.app| app)?\s+(now|today)/i,
  /available (now |today )?(on|in) the (mac(os)? )?app store/i,
  /(google )?play (store )?production/i,
  /\bendbar[ -]?go\b/i,
  /notarized (macos )?app is (now )?available/i,
  /friday\.app is (now )?(available|released|shipping|live|out)\b/i,
];

describe("DIST-NPM-CONSUMER-001: npm = tooling/non-consumer surface", () => {
  describe("(a) consumer-install guidance does NOT present npm as the install path", () => {
    it("getting-started no longer offers npm as a formal install option", () => {
      const doc = readRepoFile("docs/getting-started.md");
      // The old copy presented "Option A - npm package" as a co-equal formal
      // consumer install path. That framing must be gone.
      expect(doc).not.toMatch(/option a\s*[-–—]\s*npm package/i);
      // Any global-install command must be explicitly labeled non-consumer.
      if (/npm install -g @thesongzhu\/friday/.test(doc)) {
        expect(doc).toContain(EN_MARKER);
        expect(doc).toContain(EN_NOT_CONSUMER);
      }
    });

    it("getting-started carries the non-consumer relabel + honest app status", () => {
      const doc = readRepoFile("docs/getting-started.md");
      expect(doc).toContain(EN_MARKER);
      expect(doc).toContain(EN_NOT_CONSUMER);
      expect(doc).toContain(EN_VEHICLE);
      expect(doc).toContain(EN_NOT_RELEASED);
    });

    it("English README carries the non-consumer relabel", () => {
      const doc = readRepoFile("README.md");
      expect(doc).toContain(EN_MARKER);
      expect(doc).toContain(EN_NOT_CONSUMER);
      expect(doc).toContain(EN_VEHICLE);
      expect(doc).toContain(EN_NOT_RELEASED);
    });

    it("Chinese README carries the non-consumer relabel", () => {
      const doc = readRepoFile("README.zh-CN.md");
      expect(doc).toContain(ZH_MARKER);
      expect(doc).toContain(ZH_NOT_CONSUMER);
    });

    it("public-v1 disposition doc labels npm non-consumer, app as vehicle, status NO_GO", () => {
      const doc = readRepoFile("docs/public-v1-local-candidate.md");
      expect(doc.toLowerCase()).toContain("non-consumer");
      expect(doc.toLowerCase()).toContain("tooling");
      expect(doc).toContain(EN_VEHICLE);
      // A docs fix does not close any release parent: product status stays NO_GO.
      expect(doc).toMatch(/product[_ ]status[^\n]*no[_ -]?go/i);
    });

    it("cross-platform downloads labels the npm channel as developer/tooling", () => {
      const doc = readRepoFile("docs/ops/friday-cross-platform-downloads.md");
      // Every npm-install mention here is a developer/tooling fallback, never
      // a consumer vehicle.
      expect(doc.toLowerCase()).toContain("developer");
      expect(doc).toContain(EN_MARKER);
    });

    it("open-source release review does not call npm the installable runtime artifact", () => {
      const doc = readRepoFile("docs/open-source-release-review.md");
      // The old twin of the public-v1 sentence must be relabeled, not left as a
      // bare "installable runtime artifact" (which reads as a consumer install).
      expect(doc).not.toContain("The npm package is the installable runtime artifact");
      expect(doc).toContain("developer/build/tooling runtime artifact");
      expect(doc.toLowerCase()).toContain("not the consumer install vehicle");
    });

    it("release-notes template qualifies the npm upgrade path as non-consumer", () => {
      const doc = readRepoFile("docs/RELEASE_NOTES_TEMPLATE.md");
      // The npm global-install upgrade line must carry the non-consumer
      // qualifier while keeping the source-rebuild alternative.
      expect(doc).toMatch(
        /npm install -g @thesongzhu\/friday@X\.Y\.Z[^\n]*not a consumer install/i,
      );
      expect(doc).toContain("or source rebuild");
      expect(doc).toContain(EN_MARKER);
    });
  });

  describe("(b) tooling/dev instructions remain present and valid", () => {
    it("getting-started keeps the source-build / dev workflow", () => {
      const doc = readRepoFile("docs/getting-started.md");
      for (const cmd of ["git clone", "npm install", "npm run build", "npm test"]) {
        expect(doc).toContain(cmd);
      }
    });

    it("npm package + build pipeline are NOT deleted", () => {
      const pkg = JSON.parse(readRepoFile("package.json")) as {
        name: string;
        bin?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      expect(pkg.name).toBe("@thesongzhu/friday");
      expect(pkg.bin?.friday).toBe("dist/cli/friday-cli.js");
      expect(pkg.scripts?.build).toBeTruthy();
      // CLI source (the tooling surface itself) still exists.
      expect(existsSync(resolve(repoRoot, "src/cli/friday-cli.ts"))).toBe(true);
    });
  });

  describe("(c) no source-only / native-release over-claim strings", () => {
    for (const file of CONSUMER_FACING_DOCS) {
      it(`${file} makes no not-yet-true release claim`, () => {
        const doc = readRepoFile(file);
        for (const pattern of OVERCLAIM_PATTERNS) {
          expect(doc).not.toMatch(pattern);
        }
      });
    }
  });

  describe("(d) referenced in-repo links and commands are well-formed", () => {
    it("in-repo paths referenced by the install/tooling story exist", () => {
      const referenced = [
        "docs/public-v1-local-candidate.md",
        "docs/getting-started.md",
        "docs/EXTENDING.md",
        "docs/TROUBLESHOOTING.md",
        "Friday Setup.command",
        "src/cli/friday-cli.ts",
      ];
      for (const path of referenced) {
        expect(existsSync(resolve(repoRoot, path)), `${path} should exist`).toBe(true);
      }
    });

    it("npm-script commands referenced in the dev docs actually exist", () => {
      const pkg = JSON.parse(readRepoFile("package.json")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      for (const name of ["build", "test", "lint", "typecheck"]) {
        expect(scripts[name], `npm script "${name}" should exist`).toBeTruthy();
      }
    });
  });
});
