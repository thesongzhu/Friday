/**
 * B1 interop runner BUILD STEP. Bundles the REAL sealed client + the runner into a single
 * `.cjs` that `node` can run without a repo build step. The Rust interop test (and a human
 * re-running it) invokes this first, then spawns `node <out>`.
 *
 * A tiny resolve plugin rewrites relative `.js` specifiers (the TS Node16 ESM convention) to
 * their `.ts` source so esbuild bundles from source — no prior `tsc` build required.
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolvePath(here, "friday-rust-hub-agent-run-sealed-client-runner.ts");
const outfile = resolvePath(here, ".build/sealed-client-runner.cjs");

const tsFromJsPlugin = {
  name: "ts-from-js",
  setup(b) {
    b.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const tsCandidate = resolvePath(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (existsSync(tsCandidate)) {
        return { path: tsCandidate };
      }
      return undefined;
    });
  },
};

// The repo maps package imports to BUILT `dist/` paths; this interop bundle resolves them to source
// so no prior `tsc` build is needed.
const repoRoot = resolvePath(here, "..", "..");
const errorsSource = resolvePath(repoRoot, "src/errors/index.ts");
const versionShim = resolvePath(here, "friday-version-shim.ts");
const versionSource = resolvePath(repoRoot, "src/lib/version.js");
const packageImportPlugin = {
  name: "friday-package-imports",
  setup(b) {
    b.onResolve({ filter: /^#([^/]+)$/ }, (args) => {
      return { path: resolvePath(repoRoot, "src", args.path.slice(1), "index.ts") };
    });
    b.onResolve({ filter: /^#([^/]+)\/(.+)$/ }, (args) => {
      const [, pkg, rest] = args.path.match(/^#([^/]+)\/(.+)$/) ?? [];
      if (!pkg || !rest) return undefined;
      return { path: resolvePath(repoRoot, "src", pkg, rest, "index.ts") };
    });
  },
};
const interopShimPlugin = {
  name: "friday-interop-shims",
  setup(b) {
    b.onResolve({ filter: /version\.js$/ }, (args) => {
      const resolved = resolvePath(args.resolveDir, args.path);
      if (resolved === versionSource) {
        return { path: versionShim };
      }
      return undefined;
    });
  },
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  // CJS output: `ws` does dynamic `require("events")` etc., which only resolves natively in a
  // CJS module — an ESM bundle would throw "Dynamic require not supported".
  format: "cjs",
  target: "node22",
  alias: { "#errors": errorsSource },
  // Native DB and browser-control deps are left to the repo's node_modules; they are not part of
  // the Rust sealed-client protocol this bundle is proving.
  plugins: [interopShimPlugin, packageImportPlugin, tsFromJsPlugin],
  external: [
    "better-sqlite3",
    "chromium-bidi/*",
    "playwright",
    "playwright-core",
    "playwright-core/*",
  ],
  logLevel: "info",
});

process.stdout.write(`built ${outfile}\n`);
