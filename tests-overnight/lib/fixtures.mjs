// Generate fixtures lazily (no extra npm deps).
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { WORKSPACE_FIXTURE_DIR } from "./util.mjs";

const FIX = WORKSPACE_FIXTURE_DIR;
mkdirSync(FIX, { recursive: true });

/** Build a 64x64 solid red PNG using zlib, no deps (CRC computed manually). */
import zlib from "node:zlib";
import { createHash } from "node:crypto";

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
  const tBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tBuf, data])), 0);
  return Buffer.concat([length, tBuf, data, crc]);
}
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeSolidPng(width, height, [r, g, b], outPath) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const off = y * (width * 3 + 1) + 1 + x * 3;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
    }
  }
  const idatData = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(outPath, png);
  return outPath;
}

/** Render a low-tech text PNG: pixel-grid rendering of digits. */
export function makeTextPng(text, outPath) {
  const FONT = {
    "0": ["111","101","101","101","111"],
    "1": ["010","110","010","010","111"],
    "2": ["111","001","111","100","111"],
    "3": ["111","001","111","001","111"],
    "4": ["101","101","111","001","001"],
    "5": ["111","100","111","001","111"],
    "6": ["111","100","111","101","111"],
    "7": ["111","001","010","010","010"],
    "8": ["111","101","111","101","111"],
    "9": ["111","101","111","001","111"],
    "S": ["111","100","111","001","111"],
    "T": ["111","010","010","010","010"],
    "A": ["111","101","111","101","101"],
    "B": ["110","101","110","101","110"],
    "I": ["111","010","010","010","111"],
    "L": ["100","100","100","100","111"],
    "Y": ["101","101","010","010","010"],
    "O": ["111","101","101","101","111"],
    "C": ["111","100","100","100","111"],
    "R": ["110","101","110","101","101"],
    "-": ["000","000","111","000","000"],
    " ": ["000","000","000","000","000"],
  };
  const scale = 6;
  const padding = 8;
  const charW = 3 * scale, charH = 5 * scale, gap = scale;
  const upper = text.toUpperCase();
  const w = padding * 2 + upper.length * (charW + gap) - gap;
  const h = padding * 2 + charH;
  // Build pixel buffer: white background, black text
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0xff);
  // Force scanline filter to 0 then fill white
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  function px(x, y, [r, g, b]) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const off = y * (w * 3 + 1) + 1 + x * 3;
    raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
  }
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    const glyph = FONT[ch];
    if (!glyph) continue;
    const baseX = padding + i * (charW + gap);
    const baseY = padding;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] === "1") {
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++)
              px(baseX + col * scale + dx, baseY + row * scale + dy, [0, 0, 0]);
        }
      }
    }
  }
  const idatData = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(outPath, png);
  return outPath;
}

/** Minimal valid PDF with a marker phrase. */
export function makeMarkerPdf(marker, outPath) {
  // Hand-rolled PDF 1.4 with one page and a single text show.
  const lines = [];
  lines.push("%PDF-1.4");
  const objs = [];
  function addObj(content) { objs.push(content); return objs.length; }
  const catalogId = addObj("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const pageId = addObj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  const stream = `BT /F1 18 Tf 36 120 Td (${marker}) Tj ET`;
  const contentObj = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  addObj(contentObj);
  addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const offsets = [];
  let body = "%PDF-1.4\n";
  for (let i = 0; i < objs.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  writeFileSync(outPath, body);
  return outPath;
}

/** Produce all fixtures used by the gauntlet. */
export function ensureAllFixtures() {
  const out = {};
  out.redPng = makeSolidPng(64, 64, [220, 30, 30], `${FIX}/red-square.png`);
  out.ocrPng = makeTextPng("STABILITY OCR 12345", `${FIX}/ocr-text.png`);
  out.pdf = makeMarkerPdf("STABILITY-PDF-MARKER-X7Q", `${FIX}/sample.pdf`);
  // CSV: 10 rows, col 2 sums to 145 (0+1+...+9 → wait no, 1+2+..+10 = 55? we'll use 1..10 and value*10 = 55*10=550). Make it explicit.
  const rows = [["id","value"]];
  let sum = 0;
  for (let i = 1; i <= 10; i++) { rows.push([String(i), String(i * 7)]); sum += i * 7; }
  // sum = 7*(1+2+...+10) = 385
  out.csv = `${FIX}/sample.csv`;
  writeFileSync(out.csv, rows.map(r => r.join(",")).join("\n"));
  out.csvSum = sum;
  // Sample workflow DAG (must match Friday's workflow schema; if route schema differs, phase G handles).
  out.workflow = `${FIX}/sample-workflow.json`;
  writeFileSync(out.workflow, JSON.stringify({
    name: "stability-sample-workflow",
    description: "smoke",
    nodes: [
      { id: "start", kind: "start" },
      { id: "step1", kind: "log", inputs: { message: "hello-world-stability" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "step1" },
      { from: "step1", to: "end" },
    ],
  }, null, 2));
  // Failing workflow
  out.workflowFail = `${FIX}/sample-workflow-fail.json`;
  writeFileSync(out.workflowFail, JSON.stringify({
    name: "stability-fail-workflow",
    description: "intentional fail",
    nodes: [
      { id: "start", kind: "start" },
      { id: "step1", kind: "exec", inputs: { command: "false" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "step1" },
      { from: "step1", to: "end" },
    ],
  }, null, 2));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(ensureAllFixtures(), null, 2));
}
