#!/usr/bin/env node
/**
 * MECHANISM-2: Migration Chain Integrity Guard
 *
 * Validates:
 * 1. Migration files are contiguous (v001..vNNN with no gaps)
 * 2. Every migration file is registered in index.ts
 * 3. index.ts array order matches file version order (exact position-by-position)
 * 4. Migration files have the expected naming pattern
 * 5. No nonconforming .ts files in the migrations directory
 * 6. Array entries resolve exactly to discovered migration files
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = "src/state/sqlite/migrations";
const INDEX_FILE = join(MIGRATIONS_DIR, "index.ts");

let errors = 0;

function fail(msg) {
  console.error(`❌ ${msg}`);
  errors++;
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

// ── 1. Scan all .ts files and enforce naming ──
const allFiles = await readdir(MIGRATIONS_DIR);
const tsFiles = allFiles.filter((f) => f.endsWith(".ts"));

// Allowlist: non-migration utility files
const UTILITY_ALLOWLIST = new Set(["index.ts", "friday-migration.types.ts"]);

const migrationNameRegex = /^v(\d{3})-[a-z0-9-]+\.ts$/;
const migrationFiles = [];

for (const f of tsFiles) {
  if (UTILITY_ALLOWLIST.has(f)) continue;

  const m = f.match(migrationNameRegex);
  if (!m) {
    fail(`Nonconforming migration file: ${f} (must match v###-lowercase-kebab.ts)`);
  } else {
    migrationFiles.push(f);
  }
}

migrationFiles.sort();

if (migrationFiles.length === 0) {
  fail("No migration files found");
  process.exit(1);
}

// ── 2. Check contiguous versions ──
const versions = migrationFiles.map((f) => {
  const m = f.match(/^v(\d{3})/);
  return parseInt(m[1], 10);
});
const maxVersion = Math.max(...versions);
const expectedVersions = Array.from({ length: maxVersion }, (_, i) => i + 1);

const missing = expectedVersions.filter((v) => !versions.includes(v));
if (missing.length > 0) {
  fail(
    `Missing migration versions: ${missing.map((v) => `v${String(v).padStart(3, "0")}`).join(", ")}`
  );
} else {
  ok(`${migrationFiles.length} migrations, contiguous v001–v${String(maxVersion).padStart(3, "0")}`);
}

// Check for duplicates
const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
if (dupes.length > 0) {
  fail(`Duplicate migration versions: ${dupes.join(", ")}`);
}

// ── 3. Read index.ts and build import map ──
const indexContent = await readFile(INDEX_FILE, "utf-8");

// Build constName -> importedFileBase map from `import { CONST } from "./file.js"` lines
const importMap = new Map(); // constName -> fileBase (without extension)
const importLineRegex = /import\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g;
let importMatch;
while ((importMatch = importLineRegex.exec(indexContent)) !== null) {
  const constName = importMatch[1].trim();
  // Normalize: strip .js or .ts extension to get the base name
  const fileBase = importMatch[2].replace(/\.(js|ts)$/, "");
  // Skip type-only imports
  if (constName.startsWith("type ")) continue;
  importMap.set(constName, fileBase);
}

// Check each migration file is imported
for (const f of migrationFiles) {
  const base = f.replace(/\.ts$/, "");
  const imported = [...importMap.values()].includes(base);
  if (!imported) {
    fail(`Migration ${f} is NOT imported in index.ts`);
  }
}

// ── 4. Parse FRIDAY_SQLITE_MIGRATIONS array and verify exact match ──
const arrayMatch = indexContent.match(
  /FRIDAY_SQLITE_MIGRATIONS[^=]*=\s*\[([\s\S]*?)\];/
);
if (!arrayMatch) {
  fail("Could not find FRIDAY_SQLITE_MIGRATIONS array in index.ts");
} else {
  const arrayEntries = arrayMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("//"));

  // Validate each entry is an identifier and is imported
  for (let i = 0; i < arrayEntries.length; i++) {
    const entry = arrayEntries[i];
    if (!/^[A-Z_][A-Z0-9_]*$/.test(entry)) {
      fail(`Array entry at position ${i} is not a valid identifier: "${entry}"`);
      continue;
    }
    if (!importMap.has(entry)) {
      fail(`Array entry "${entry}" at position ${i} is not imported in index.ts`);
    }
  }

  // Build expected ordered list from migration files
  const expectedOrder = migrationFiles.map((f) => f.replace(/\.ts$/, ""));

  // Build actual ordered list from array entries by resolving through import map
  const actualOrder = arrayEntries
    .filter((e) => importMap.has(e))
    .map((e) => importMap.get(e));

  // Compare position-by-position
  const maxLen = Math.max(expectedOrder.length, actualOrder.length);
  let orderOk = true;
  for (let i = 0; i < maxLen; i++) {
    const expected = expectedOrder[i] || "(missing)";
    const actual = actualOrder[i] || "(missing)";
    if (expected !== actual) {
      fail(
        `Position ${i}: expected "${expected}" but found "${actual}" in FRIDAY_SQLITE_MIGRATIONS`
      );
      orderOk = false;
    }
  }

  if (orderOk && expectedOrder.length === actualOrder.length) {
    ok("Migration array exactly matches discovered migration files in order");
  }

  // Check count matches
  if (arrayEntries.length !== migrationFiles.length) {
    fail(
      `Array has ${arrayEntries.length} entries but found ${migrationFiles.length} migration files`
    );
  } else {
    ok("Migration array count matches file count");
  }
}

if (errors > 0) {
  console.error(`\n💥 ${errors} migration integrity error(s) found`);
  process.exit(1);
} else {
  console.log("\n🎉 Migration chain integrity: all checks passed");
}
