import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createFridayAgentPdfParseTool } from "../../../../src/agent/tools/friday-agent-pdf-parse-tool.js";

const SIMPLE_TEXT_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 44 >>
stream
BT
/F1 24 Tf
100 700 Td
(Hello Friday) Tj
ET
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000311 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
405
%%EOF`;

describe("createFridayAgentPdfParseTool", () => {
  it("extracts text from a workspace PDF", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pdf-"));
    const pdfPath = path.join(tmpDir, "sample.pdf");
    fs.writeFileSync(pdfPath, SIMPLE_TEXT_PDF);
    const tool = createFridayAgentPdfParseTool({ workspaceRoot: tmpDir });

    const result = await tool.execute({ path: "sample.pdf" }, new AbortController().signal);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.text).toContain("Hello Friday");
  });

  it("rejects paths outside the workspace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pdf-"));
    const outsidePath = path.join(os.tmpdir(), "outside-friday.pdf");
    fs.writeFileSync(outsidePath, SIMPLE_TEXT_PDF);
    const tool = createFridayAgentPdfParseTool({ workspaceRoot: tmpDir });

    const result = await tool.execute({ path: outsidePath }, new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not allowed");
  });
});
