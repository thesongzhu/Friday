#!/usr/bin/env node
/**
 * MECHANISM-5: SSD Freshness + Status Marker Lint
 *
 * Validates:
 * 1. The SSD document exists
 * 2. §0.3 marker definition section exists
 * 3. Every ### block under §2–§10 has at least one [Implemented]/[Partial]/[Planned] marker
 * 4. Every endpoint line in §11 matching /v1/ or /api/ has a marker on that line
 * 5. Reports summary stats with counters
 */

import { readFile } from "node:fs/promises";

const SSD_PATH = "docs/distributed-architecture.md";

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`❌ ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`⚠️  ${msg}`);
  warnings++;
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

// 1. Read SSD
let content;
try {
  content = await readFile(SSD_PATH, "utf-8");
} catch {
  fail(`SSD file not found: ${SSD_PATH}`);
  process.exit(1);
}

const lines = content.split("\n");

// 2. Check §0.3 marker definition exists
if (!content.includes("Implementation Status Markers")) {
  fail("Missing §0.3 Implementation Status Markers section");
} else {
  ok("§0.3 Implementation Status Markers section found");
}

// 3. Check for invalid/typo markers
const VALID_MARKERS = ["[Implemented]", "[Partial]", "[Planned]"];
const markerRegex = /\[(Implemented|Partial|Planned)\]/;

const invalidMarkerRegex =
  /\[(implemented|partial|planned|IMPLEMENTED|PARTIAL|PLANNED|Impl|Todo|TODO|WIP|DONE)\]/i;
for (let i = 0; i < lines.length; i++) {
  const invalidMatch = lines[i].match(invalidMarkerRegex);
  if (invalidMatch && !VALID_MARKERS.includes(invalidMatch[0])) {
    warn(
      `Line ${i + 1}: Possible invalid marker: ${invalidMatch[0]} (use [Implemented], [Partial], or [Planned])`
    );
  }
}

// ── 4. Section-aware validation for §2–§10 ──
// Parse top-level sections (## N.) to find range for §2..§10
const sectionRanges = []; // {num, title, startLine, endLine}
const topSectionRegex = /^## (\d+)\.\s/;

for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(topSectionRegex);
  if (m) {
    const num = parseInt(m[1], 10);
    if (sectionRanges.length > 0) {
      sectionRanges[sectionRanges.length - 1].endLine = i;
    }
    sectionRanges.push({ num, title: lines[i], startLine: i, endLine: lines.length });
  }
}

// Find subsection (###) blocks within §2–§10
let checkedSections = 0;
let missingSections = 0;

for (const sec of sectionRanges) {
  if (sec.num < 2 || sec.num > 10) continue;

  // Find ### blocks within this section
  const subBlocks = []; // {title, startLine, endLine}
  for (let i = sec.startLine; i < sec.endLine; i++) {
    if (lines[i].startsWith("### ")) {
      if (subBlocks.length > 0) {
        subBlocks[subBlocks.length - 1].endLine = i;
      }
      subBlocks.push({ title: lines[i].trim(), startLine: i, endLine: sec.endLine });
    }
  }

  for (const block of subBlocks) {
    checkedSections++;
    let hasMarker = false;
    for (let i = block.startLine; i < block.endLine; i++) {
      if (markerRegex.test(lines[i])) {
        hasMarker = true;
        break;
      }
    }
    if (!hasMarker) {
      fail(`Section missing status marker: ${block.title} (lines ${block.startLine + 1}–${block.endLine})`);
      missingSections++;
    }
  }
}

if (missingSections === 0) {
  ok(`All ${checkedSections} subsections in §2–§10 have status markers`);
} else {
  console.error(`   ${missingSections}/${checkedSections} subsections missing markers`);
}

// ── 5. Endpoint line validation in §11 ──
const section11 = sectionRanges.find((s) => s.num === 11);
let checkedEndpoints = 0;
let missingEndpoints = 0;

if (!section11) {
  fail("§11 API Reference section not found");
} else {
  const endpointRouteRegex = /(?:`[^`]*\/(?:v1|api)\/[^`]*`|\/(?:v1|api)\/\S+)/;

  for (let i = section11.startLine; i < section11.endLine; i++) {
    if (endpointRouteRegex.test(lines[i])) {
      checkedEndpoints++;
      if (!markerRegex.test(lines[i])) {
        fail(`Line ${i + 1}: Endpoint line missing status marker: ${lines[i].trim().slice(0, 100)}`);
        missingEndpoints++;
      }
    }
  }

  if (missingEndpoints === 0 && checkedEndpoints > 0) {
    ok(`All ${checkedEndpoints} endpoint lines in §11 have status markers`);
  } else if (checkedEndpoints > 0) {
    console.error(`   ${missingEndpoints}/${checkedEndpoints} endpoint lines missing markers`);
  } else {
    warn("No endpoint lines detected in §11");
  }
}

// 6. Summary stats
const implemented = (content.match(/\[Implemented\]/g) || []).length;
const partial = (content.match(/\[Partial\]/g) || []).length;
const planned = (content.match(/\[Planned\]/g) || []).length;

console.log(`\n📊 SSD Marker Summary:`);
console.log(`   [Implemented]: ${implemented}`);
console.log(`   [Partial]:     ${partial}`);
console.log(`   [Planned]:     ${planned}`);
console.log(`   Total:         ${implemented + partial + planned}`);
console.log(`\n📊 Coverage Summary:`);
console.log(`   Sections checked (§2–§10): ${checkedSections}, missing: ${missingSections}`);
console.log(`   Endpoints checked (§11):   ${checkedEndpoints}, missing: ${missingEndpoints}`);

if (errors > 0) {
  console.error(`\n💥 ${errors} SSD marker error(s) found`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`\n⚠️  ${warnings} warning(s), but no blocking errors`);
} else {
  console.log("\n🎉 SSD marker lint: all checks passed");
}
