import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const SOURCE_HTML = path.join(ROOT, "friday-static.html");
const OUTPUT_HTML = path.join(ROOT, "friday-static.prod.html");
const PACKAGE_JSON = path.join(ROOT, "package.json");

function replaceExact(source, searchValue, replaceValue, label) {
  if (!source.includes(searchValue)) {
    throw new Error(`Missing ${label} replacement target.`);
  }
  return source.replace(searchValue, replaceValue);
}

async function main() {
  const [sourceHtml, packageJsonRaw] = await Promise.all([
    fs.readFile(SOURCE_HTML, "utf8"),
    fs.readFile(PACKAGE_JSON, "utf8")
  ]);

  const packageJson = JSON.parse(packageJsonRaw);
  const version = String(packageJson.version || "0.0.0");

  let prodHtml = sourceHtml;

  prodHtml = replaceExact(
    prodHtml,
    "window.__fridayMock = fridayMockStore;",
    "var __fridayMockStore = fridayMockStore;",
    "__fridayMock assignment"
  );
  prodHtml = prodHtml.replaceAll("window.__fridayMock", "__fridayMockStore");

  prodHtml = replaceExact(
    prodHtml,
    "window.__fridayQa = createFridayQaApi();",
    "var __fridayQaApi = createFridayQaApi();",
    "__fridayQa assignment"
  );
  prodHtml = prodHtml.replaceAll("window.__fridayQa", "__fridayQaApi");

  prodHtml = prodHtml.replace("window.useHomeSurfacePreferences = useHomeSurfacePreferences;\n", "");
  prodHtml = prodHtml.replace("window.crossBorderPackApi = crossBorderPackApi;\n", "");

  if (prodHtml.includes("window.__fridayMock") || prodHtml.includes("window.__fridayQa")) {
    throw new Error("Prod build still leaks QA globals.");
  }

  const healthScript = [
    "<script>",
    `window.__fridayVersion = ${JSON.stringify(version)};`,
    "window.__fridayHealth = function fridayHealth() {",
    "  return {",
    "    ok: true,",
    "    build: 'prod-static',",
    "    version: window.__fridayVersion,",
    "    route: window.location.pathname + window.location.search,",
    "    title: document.title,",
    "    generatedAt: new Date().toISOString()",
    "  };",
    "};",
    "</script>"
  ].join("");

  prodHtml = replaceExact(prodHtml, "</body>", `${healthScript}</body>`, "closing body");

  await fs.writeFile(OUTPUT_HTML, prodHtml);
  process.stdout.write(`${OUTPUT_HTML}\n`);
}

await main();
