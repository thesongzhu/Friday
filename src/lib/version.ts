import { createRequire } from "node:module";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);

/** Read the version from the root package.json. */
function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const pkg = require(pkgPath) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch (err) {
    console.warn("[friday][version] package.json read failed:", err instanceof Error ? err.message : String(err));
    return "0.0.0";
  }
}

/** The Friday platform version, read from package.json. */
export const FRIDAY_VERSION: string = readPackageVersion();
