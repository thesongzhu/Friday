import { describe, it, expect, vi } from "vitest";
import {
  detectMediaType,
  buildAttachmentList,
  applyAttachmentPolicy,
  DEFAULT_MEDIA_UNDERSTANDING_CONFIG,
  resolveProvider,
  formatEnrichmentBlock,
  formatContextSection,
  createFridayMediaUnderstandingService,
} from "../../../src/media-understanding/index.js";
import type {
  FridayMediaAttachment,
  FridayMediaUnderstandingProvider,
  FridayMediaUnderstandingConfig,
} from "../../../src/media-understanding/index.js";

// ─── Helpers ───

function makeAttachment(overrides: Partial<FridayMediaAttachment> = {}): FridayMediaAttachment {
  return {
    id: "att-1",
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    mediaType: "image",
    sizeBytes: 1024,
    sourceUrl: "https://example.com/photo.jpg",
    ...overrides,
  };
}

function makeProvider(
  providerId: string,
  mediaTypes: FridayMediaAttachment["mediaType"][],
  output?: Partial<ReturnType<typeof makeOutput>>,
): FridayMediaUnderstandingProvider {
  return {
    providerId,
    supportedMediaTypes: mediaTypes,
    process: vi.fn().mockResolvedValue(makeOutput(output)),
  };
}

function makeOutput(overrides: Partial<{
  description: string;
  confidence: number;
  provider: string;
  processingMs: number;
}> = {}) {
  return {
    description: "A test image",
    confidence: 0.95,
    provider: "test-provider",
    processingMs: 100,
    ...overrides,
  };
}

// ─── detectMediaType ───

describe("detectMediaType", () => {
  it("detects image types", () => {
    expect(detectMediaType("image/jpeg")).toBe("image");
    expect(detectMediaType("image/png")).toBe("image");
    expect(detectMediaType("image/gif")).toBe("image");
  });

  it("detects audio types", () => {
    expect(detectMediaType("audio/mpeg")).toBe("audio");
    expect(detectMediaType("audio/wav")).toBe("audio");
  });

  it("detects video types", () => {
    expect(detectMediaType("video/mp4")).toBe("video");
  });

  it("detects document types", () => {
    expect(detectMediaType("application/pdf")).toBe("document");
    expect(detectMediaType("text/plain")).toBe("document");
  });

  it("defaults to document for unknown types", () => {
    expect(detectMediaType("application/octet-stream")).toBe("document");
  });

  it("is case-insensitive", () => {
    expect(detectMediaType("IMAGE/JPEG")).toBe("image");
  });
});

// ─── buildAttachmentList ───

describe("buildAttachmentList", () => {
  it("converts raw inputs to typed attachments", () => {
    const result = buildAttachmentList([
      { id: "1", filename: "test.png", mimeType: "image/png", sizeBytes: 500, url: "https://x.com/1" },
      { id: "2", mimeType: "audio/mp3", sizeBytes: 1000, url: "https://x.com/2" },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].mediaType).toBe("image");
    expect(result[0].filename).toBe("test.png");
    expect(result[1].mediaType).toBe("audio");
    expect(result[1].filename).toBeNull();
  });
});

// ─── applyAttachmentPolicy ───

describe("applyAttachmentPolicy", () => {
  const config: FridayMediaUnderstandingConfig = {
    ...DEFAULT_MEDIA_UNDERSTANDING_CONFIG,
    maxFileSizeBytes: 10_000,
    maxAttachmentsPerMessage: 2,
  };

  it("passes eligible attachments", () => {
    const attachments = [makeAttachment({ id: "a1", sizeBytes: 5000 })];
    const { eligible, decisions } = applyAttachmentPolicy(attachments, config);
    expect(eligible).toHaveLength(1);
    expect(decisions).toHaveLength(0);
  });

  it("skips oversized attachments", () => {
    const attachments = [makeAttachment({ id: "a2", sizeBytes: 50_000 })];
    const { eligible, decisions } = applyAttachmentPolicy(attachments, config);
    expect(eligible).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("skipped_size");
  });

  it("skips disallowed MIME types", () => {
    const attachments = [makeAttachment({ id: "a3", mimeType: "application/zip" })];
    const { eligible, decisions } = applyAttachmentPolicy(attachments, config);
    expect(eligible).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("skipped_mime");
  });

  it("enforces attachment limit", () => {
    const attachments = [
      makeAttachment({ id: "a4" }),
      makeAttachment({ id: "a5" }),
      makeAttachment({ id: "a6" }),
    ];
    const { eligible, decisions } = applyAttachmentPolicy(attachments, config);
    expect(eligible).toHaveLength(2);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("skipped_limit");
    expect(decisions[0].attachmentId).toBe("a6");
  });
});

// ─── resolveProvider ───

describe("resolveProvider", () => {
  it("returns matching provider for media type", () => {
    const imageProvider = makeProvider("img-prov", ["image"]);
    const audioProvider = makeProvider("aud-prov", ["audio"]);

    const result = resolveProvider(
      makeAttachment({ mediaType: "image" }),
      [imageProvider, audioProvider],
    );
    expect(result?.providerId).toBe("img-prov");
  });

  it("returns undefined when no provider matches", () => {
    const audioProvider = makeProvider("aud-prov", ["audio"]);
    const result = resolveProvider(
      makeAttachment({ mediaType: "video" }),
      [audioProvider],
    );
    expect(result).toBeUndefined();
  });
});

// ─── formatEnrichmentBlock ───

describe("formatEnrichmentBlock", () => {
  it("formats block with filename", () => {
    const block = formatEnrichmentBlock(
      makeAttachment({ filename: "screenshot.png" }),
      makeOutput({ description: "A screenshot of a dashboard" }),
    );
    expect(block.formattedBlock).toContain("[Attachment: screenshot.png]");
    expect(block.formattedBlock).toContain("A screenshot of a dashboard");
  });

  it("uses media type when no filename", () => {
    const block = formatEnrichmentBlock(
      makeAttachment({ filename: null }),
      makeOutput(),
    );
    expect(block.formattedBlock).toContain("[Attachment: image]");
  });

  it("includes transcription when present", () => {
    const block = formatEnrichmentBlock(
      makeAttachment({ mediaType: "audio" }),
      { ...makeOutput(), transcription: "Hello world" },
    );
    expect(block.formattedBlock).toContain("Transcription: Hello world");
  });
});

// ─── formatContextSection ───

describe("formatContextSection", () => {
  it("returns empty string for no blocks", () => {
    expect(formatContextSection([])).toBe("");
  });

  it("wraps blocks in section markers", () => {
    const block = formatEnrichmentBlock(makeAttachment(), makeOutput());
    const result = formatContextSection([block]);
    expect(result).toContain("--- Media Attachments ---");
    expect(result).toContain("--- End Attachments ---");
  });
});

// ─── Service ───

describe("FridayMediaUnderstandingService", () => {
  it("returns empty when disabled", async () => {
    const service = createFridayMediaUnderstandingService({
      providers: [],
      fetchContent: vi.fn(),
      config: { ...DEFAULT_MEDIA_UNDERSTANDING_CONFIG, enabled: false },
    });

    const result = await service.processAttachments([makeAttachment()]);
    expect(result.enrichments).toHaveLength(0);
  });

  it("returns empty for empty attachment list", async () => {
    const service = createFridayMediaUnderstandingService({
      providers: [],
      fetchContent: vi.fn(),
    });

    const result = await service.processAttachments([]);
    expect(result.enrichments).toHaveLength(0);
  });

  it("processes eligible attachments through providers", async () => {
    const provider = makeProvider("test", ["image"]);
    const service = createFridayMediaUnderstandingService({
      providers: [provider],
      fetchContent: vi.fn().mockResolvedValue(Buffer.from("fake")),
    });

    const result = await service.processAttachments([makeAttachment()]);

    expect(result.enrichments).toHaveLength(1);
    expect(result.enrichments[0].output.description).toBe("A test image");
    expect(result.decisions.some((d) => d.action === "processed")).toBe(true);
  });

  it("records failed provider calls", async () => {
    const provider: FridayMediaUnderstandingProvider = {
      providerId: "failing",
      supportedMediaTypes: ["image"],
      process: vi.fn().mockRejectedValue(new Error("Provider crashed")),
    };
    const service = createFridayMediaUnderstandingService({
      providers: [provider],
      fetchContent: vi.fn().mockResolvedValue(Buffer.from("data")),
    });

    const result = await service.processAttachments([makeAttachment()]);

    expect(result.enrichments).toHaveLength(0);
    expect(result.decisions.some((d) => d.action === "failed")).toBe(true);
  });
});
