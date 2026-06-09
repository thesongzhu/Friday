/**
 * B1 interop runner BUILD STEP. Bundles the REAL sealed client + the runner into a single
 * `.mjs` that `node` can run without the repo's `#errors` import map. The Rust interop test
 * (and a human re-running it) invokes this first, then spawns `node <out>`.
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

// The repo maps `#errors` to a BUILT `dist/` path; for this source bundle alias it to source
// so no prior `tsc` build is needed. Only `#errors` is reachable from the sealed client.
const repoRoot = resolvePath(here, "..", "..");
const errorsSource = resolvePath(repoRoot, "src/errors/index.ts");

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
  // node:* + the two real deps (ws, @noble/ciphers) bundle in; nothing is left external.
  plugins: [tsFromJsPlugin],
  logLevel: "info",
});

process.stdout.write(`built ${outfile}\n`);
