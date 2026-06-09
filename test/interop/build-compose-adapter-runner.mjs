/**
 * B1-compose interop runner BUILD STEP. Bundles the REAL resolver + service adapter + sealed
 * client + the runner into a single `.cjs` that `node` runs without the repo's import map / a
 * prior `tsc` build. The Rust interop test invokes this first, then spawns `node <out>`.
 *
 * Aliases (to SOURCE, so no `tsc` build is needed):
 *   - `#errors`    → src/errors/index.ts (FridayDomainError; reached by the adapter + resolver chain)
 *   - `#providers` → src/security/friday-secret-crypto.ts (the resolver imports ONLY `getMasterKey`
 *                    from `#providers`, which is defined+exported there; aliasing to that lean source
 *                    avoids bundling the heavy providers barrel — same function, faithful).
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolvePath(here, "friday-rust-hub-agent-run-compose-adapter-runner.ts");
const outfile = resolvePath(here, ".build/compose-adapter-runner.cjs");

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

const repoRoot = resolvePath(here, "..", "..");
const errorsSource = resolvePath(repoRoot, "src/errors/index.ts");
const providersGetMasterKeySource = resolvePath(repoRoot, "src/security/friday-secret-crypto.ts");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  alias: { "#errors": errorsSource, "#providers": providersGetMasterKeySource },
  plugins: [tsFromJsPlugin],
  logLevel: "info",
});

process.stdout.write(`built ${outfile}\n`);
