import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  imageResult,
  imageResultFromFile,
  fileResult,
  mixedResult,
} from "#agent";

describe("FridayAgentToolHelpers — Structured results", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tool-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── imageResult ───

  describe("imageResult", () => {
    it("builds result with base64 image block", () => {
      const data = Buffer.from("fake-png-data");
      const result = imageResult(data, "image/png");

      expect(result.content).toContain("image/png");
      expect(result.content).toContain("13 bytes");
      expect(result.isError).toBeUndefined();
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks![0].type).toBe("image");

      const block = result.blocks![0] as { type: "image"; mimeType: string; data: string };
      expect(block.mimeType).toBe("image/png");
      expect(block.data).toBe(data.toString("base64"));
    });

    it("uses custom description", () => {
      const data = Buffer.from("data");
      const result = imageResult(data, "image/jpeg", "Custom screenshot");

      expect(result.content).toBe("Custom screenshot");
    });
  });

  // ─── imageResultFromFile ───

  describe("imageResultFromFile", () => {
    it("reads file and builds image result", () => {
      const filePath = path.join(tmpDir, "test.png");
      fs.writeFileSync(filePath, "fake-png-bytes");

      const result = imageResultFromFile(filePath);

      expect(result.content).toContain("test.png");
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks![0].type).toBe("image");

      const block = result.blocks![0] as { type: "image"; mimeType: string; data: string };
      expect(block.mimeType).toBe("image/png");
      expect(block.data).toBe(Buffer.from("fake-png-bytes").toString("base64"));
    });

    it("guesses MIME type from extension", () => {
      const filePath = path.join(tmpDir, "test.jpg");
      fs.writeFileSync(filePath, "data");

      const result = imageResultFromFile(filePath);
      const block = result.blocks![0] as { mimeType: string };
      expect(block.mimeType).toBe("image/jpeg");
    });

    it("allows MIME type override", () => {
      const filePath = path.join(tmpDir, "test.bin");
      fs.writeFileSync(filePath, "data");

      const result = imageResultFromFile(filePath, "image/webp");
      const block = result.blocks![0] as { mimeType: string };
      expect(block.mimeType).toBe("image/webp");
    });
  });

  // ─── fileResult ───

  describe("fileResult", () => {
    it("builds file result with path", () => {
      const filePath = path.join(tmpDir, "report.pdf");
      fs.writeFileSync(filePath, "pdf-data");

      const result = fileResult(filePath);

      expect(result.content).toContain("report.pdf");
      expect(result.blocks).toHaveLength(1);

      const block = result.blocks![0] as { type: "file"; mimeType: string; path: string };
      expect(block.type).toBe("file");
      expect(block.mimeType).toBe("application/pdf");
      expect(block.path).toBe(filePath);
    });

    it("includes inline base64 data when requested", () => {
      const filePath = path.join(tmpDir, "data.json");
      fs.writeFileSync(filePath, '{"key":"value"}');

      const result = fileResult(filePath, undefined, { inline: true });
      const block = result.blocks![0] as { data?: string };
      expect(block.data).toBe(Buffer.from('{"key":"value"}').toString("base64"));
    });

    it("uses custom description", () => {
      const filePath = path.join(tmpDir, "output.txt");
      fs.writeFileSync(filePath, "data");

      const result = fileResult(filePath, undefined, { description: "My output file" });
      expect(result.content).toBe("My output file");
    });

    it("allows MIME type override", () => {
      const filePath = path.join(tmpDir, "file.bin");
      fs.writeFileSync(filePath, "data");

      const result = fileResult(filePath, "text/csv");
      const block = result.blocks![0] as { mimeType: string };
      expect(block.mimeType).toBe("text/csv");
    });
  });

  // ─── mixedResult ───

  describe("mixedResult", () => {
    it("combines text and image blocks", () => {
      const result = mixedResult([
        { type: "text", text: "Here is the screenshot:" },
        { type: "image", mimeType: "image/png", data: "base64data" },
      ]);

      expect(result.content).toBe("Here is the screenshot:");
      expect(result.blocks).toHaveLength(2);
      expect(result.isError).toBeUndefined();
    });

    it("creates fallback from non-text blocks", () => {
      const result = mixedResult([
        { type: "image", mimeType: "image/png", data: "data" },
        { type: "file", mimeType: "application/pdf", path: "/tmp/f.pdf" },
      ]);

      expect(result.content).toContain("[image: image/png]");
      expect(result.content).toContain("[file: /tmp/f.pdf]");
    });

    it("supports isError flag", () => {
      const result = mixedResult(
        [{ type: "text", text: "Error occurred" }],
        { isError: true },
      );

      expect(result.isError).toBe(true);
    });

    it("joins multiple text blocks", () => {
      const result = mixedResult([
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
      ]);

      expect(result.content).toBe("Line 1\nLine 2");
    });
  });

  // ─── Backward compatibility ───

  describe("backward compatibility", () => {
    it("always has string content field", () => {
      const data = Buffer.from("img");
      const imgResult = imageResult(data, "image/png");
      expect(typeof imgResult.content).toBe("string");
      expect(imgResult.content.length).toBeGreaterThan(0);

      const mixed = mixedResult([
        { type: "image", mimeType: "image/png", data: "d" },
      ]);
      expect(typeof mixed.content).toBe("string");
    });
  });
});
