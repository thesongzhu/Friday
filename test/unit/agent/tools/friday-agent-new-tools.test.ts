import { describe, expect, it, vi } from "vitest";

// ─── TOOL-01: Image Generate ───

describe("createFridayAgentImageGenerateTool", () => {
  async function loadTool() {
    const { createFridayAgentImageGenerateTool } = await import(
      "../../../../src/agent/tools/friday-agent-image-generate-tool.js"
    );
    return createFridayAgentImageGenerateTool;
  }

  it("generates an image and returns imageResult", async () => {
    const createTool = await loadTool();
    const fs = await import("node:fs");
    // Create a fake image file so imageResultFromFile can read it
    const tmpFile = "/tmp/image-gen-test-123.png";
    fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes

    const mockService = {
      generate: vi.fn(async () => ({
        filePath: tmpFile,
        mimeType: "image/png",
        bytes: 4,
        model: "dall-e-3",
        revisedPrompt: "a cute cat sitting",
      })),
    };
    const tool = createTool({ imageGenerateService: mockService });
    try {
      const result = await tool.execute(
        { prompt: "a cute cat" },
        new AbortController().signal,
      );

      expect(mockService.generate).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
      // imageResultFromFile returns content with description and blocks with base64
      expect(result.content).toContain("image-gen-test-123.png");
      expect(result.blocks).toBeDefined();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("returns error when prompt is missing", async () => {
    const createTool = await loadTool();
    const tool = createTool({ imageGenerateService: { generate: vi.fn() } });
    await expect(
      tool.execute({}, new AbortController().signal),
    ).rejects.toThrow(/prompt is required/i);
  });

  it("handles generation failure gracefully", async () => {
    const createTool = await loadTool();
    const mockService = {
      generate: vi.fn(async () => { throw new Error("API rate limited"); }),
    };
    const tool = createTool({ imageGenerateService: mockService });
    const result = await tool.execute(
      { prompt: "a sunset" },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("API rate limited");
  });
});

// ─── TOOL-02: Database Query ───

describe("createFridayAgentDatabaseTool", () => {
  async function loadTool() {
    const { createFridayAgentDatabaseTool } = await import(
      "../../../../src/agent/tools/friday-agent-database-tool.js"
    );
    return createFridayAgentDatabaseTool;
  }

  function mockConnector() {
    return {
      listConnections: vi.fn(() => ["main", "analytics"]),
      query: vi.fn(async () => ({
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Alice" }],
        rowCount: 1,
        truncated: false,
      })),
      schema: vi.fn(async () => ({
        tables: [{ name: "users", columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }] }],
      })),
      listTables: vi.fn(async () => ["users", "orders"]),
    };
  }

  it("lists available connections", async () => {
    const createTool = await loadTool();
    const connector = mockConnector();
    const tool = createTool({ databaseConnector: connector });
    const result = await tool.execute(
      { operation: "list_connections" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.connections).toEqual(["main", "analytics"]);
  });

  it("executes a query", async () => {
    const createTool = await loadTool();
    const connector = mockConnector();
    const tool = createTool({ databaseConnector: connector });
    const result = await tool.execute(
      { operation: "query", connection: "main", sql: "SELECT * FROM users" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.columns).toEqual(["id", "name"]);
  });

  it("lists tables", async () => {
    const createTool = await loadTool();
    const connector = mockConnector();
    const tool = createTool({ databaseConnector: connector });
    const result = await tool.execute(
      { operation: "list_tables", connection: "main" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.tables).toEqual(["users", "orders"]);
  });

  it("returns error for missing connection parameter", async () => {
    const createTool = await loadTool();
    const tool = createTool({ databaseConnector: mockConnector() });
    const result = await tool.execute(
      { operation: "query" },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("connection");
  });
});

// ─── TOOL-03: PDF Process ───

describe("createFridayAgentPdfTool", () => {
  async function loadTool() {
    const { createFridayAgentPdfTool } = await import(
      "../../../../src/agent/tools/friday-agent-pdf-tool.js"
    );
    return createFridayAgentPdfTool;
  }

  it("extracts text from a PDF", async () => {
    const createTool = await loadTool();
    const extractFn = vi.fn(async () => ({
      text: "Hello World from PDF",
      pageCount: 3,
      metadata: { author: "Test" },
    }));
    const tool = createTool({ extractFn, workspaceRoot: "/tmp" });

    // Create a temp file to pass existence check
    const fs = await import("node:fs");
    const tmpFile = "/tmp/test-pdf-extract.pdf";
    fs.writeFileSync(tmpFile, "fake pdf content");

    try {
      const result = await tool.execute(
        { operation: "extract_text", filePath: tmpFile },
        new AbortController().signal,
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.text).toBe("Hello World from PDF");
      expect(parsed.pageCount).toBe(3);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("returns error for missing filePath", async () => {
    const createTool = await loadTool();
    const tool = createTool({ extractFn: vi.fn() });
    const result = await tool.execute(
      { operation: "extract_text" },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("filePath");
  });

  it("returns error for non-existent file", async () => {
    const createTool = await loadTool();
    const tool = createTool({ extractFn: vi.fn() });
    const result = await tool.execute(
      { operation: "extract_text", filePath: "/tmp/nonexistent-pdf-12345.pdf" },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ─── TOOL-04: Email ───

describe("createFridayAgentEmailTool", () => {
  async function loadTool() {
    const { createFridayAgentEmailTool } = await import(
      "../../../../src/agent/tools/friday-agent-email-tool.js"
    );
    return createFridayAgentEmailTool;
  }

  function mockEmailService() {
    return {
      send: vi.fn(async () => ({
        messageId: "msg-001",
        accepted: ["alice@example.com"],
        rejected: [],
      })),
      list: vi.fn(async () => [
        { id: "1", from: "bob@test.com", to: ["me@test.com"], subject: "Hi", date: "2024-01-01", snippet: "Hello!", isRead: false },
      ]),
      read: vi.fn(async () => ({
        id: "1", from: "bob@test.com", to: ["me@test.com"], subject: "Hi", date: "2024-01-01", snippet: "Hello!", body: "Hello there!", isRead: true,
      })),
      search: vi.fn(async () => []),
    };
  }

  it("sends an email", async () => {
    const createTool = await loadTool();
    const service = mockEmailService();
    const tool = createTool({ emailService: service });
    const result = await tool.execute(
      { operation: "send", to: ["alice@example.com"], subject: "Test", body: "Hello" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.sent).toBe(true);
    expect(parsed.messageId).toBe("msg-001");
  });

  it("lists inbox messages", async () => {
    const createTool = await loadTool();
    const service = mockEmailService();
    const tool = createTool({ emailService: service });
    const result = await tool.execute(
      { operation: "list" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(1);
    expect(parsed.messages[0].from).toBe("bob@test.com");
  });

  it("reads a specific email", async () => {
    const createTool = await loadTool();
    const service = mockEmailService();
    const tool = createTool({ emailService: service });
    const result = await tool.execute(
      { operation: "read", messageId: "1" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.body).toBe("Hello there!");
  });
});

// ─── TOOL-05: Calendar ───

describe("createFridayAgentCalendarTool", () => {
  async function loadTool() {
    const { createFridayAgentCalendarTool } = await import(
      "../../../../src/agent/tools/friday-agent-calendar-tool.js"
    );
    return createFridayAgentCalendarTool;
  }

  function mockCalendarService() {
    return {
      listEvents: vi.fn(async () => [
        { id: "ev-1", title: "Meeting", startTime: "2024-01-15T09:00:00Z", endTime: "2024-01-15T10:00:00Z", isAllDay: false, status: "confirmed" as const },
      ]),
      createEvent: vi.fn(async (req: Record<string, unknown>) => ({
        id: "ev-2", title: req.title, startTime: req.startTime, endTime: req.endTime, isAllDay: false, status: "confirmed" as const,
      })),
      updateEvent: vi.fn(async (req: Record<string, unknown>) => ({
        id: req.eventId, title: req.title ?? "Updated", startTime: "2024-01-15T09:00:00Z", endTime: "2024-01-15T10:00:00Z", isAllDay: false, status: "confirmed" as const,
      })),
      deleteEvent: vi.fn(async () => {}),
      findFreeSlots: vi.fn(async () => [
        { start: "2024-01-15T11:00:00Z", end: "2024-01-15T12:00:00Z", durationMinutes: 60 },
      ]),
    };
  }

  it("lists events", async () => {
    const createTool = await loadTool();
    const service = mockCalendarService();
    const tool = createTool({ calendarService: service });
    const result = await tool.execute(
      { operation: "list_events", startDate: "2024-01-01T00:00:00Z", endDate: "2024-01-31T23:59:59Z" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(1);
    expect(parsed.events[0].title).toBe("Meeting");
  });

  it("creates an event", async () => {
    const createTool = await loadTool();
    const service = mockCalendarService();
    const tool = createTool({ calendarService: service });
    const result = await tool.execute(
      { operation: "create_event", title: "Lunch", startTime: "2024-01-15T12:00:00Z", endTime: "2024-01-15T13:00:00Z" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.created).toBe(true);
  });

  it("finds free slots", async () => {
    const createTool = await loadTool();
    const service = mockCalendarService();
    const tool = createTool({ calendarService: service });
    const result = await tool.execute(
      { operation: "find_free_slots", date: "2024-01-15", durationMinutes: 60 },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.slots).toHaveLength(1);
  });
});

// ─── TOOL-06: STT ───

describe("createFridayAgentSttTool", () => {
  async function loadTool() {
    const { createFridayAgentSttTool } = await import(
      "../../../../src/agent/tools/friday-agent-stt-tool.js"
    );
    return createFridayAgentSttTool;
  }

  it("transcribes audio", async () => {
    const createTool = await loadTool();
    const mockService = {
      transcribe: vi.fn(async () => ({
        text: "Hello world, this is a test.",
        model: "whisper-1",
        language: "en",
        durationSeconds: 3.5,
      })),
    };
    const tool = createTool({ sttService: mockService });
    const result = await tool.execute(
      { audioFilePath: "/tmp/test.mp3" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toBe("Hello world, this is a test.");
    expect(parsed.model).toBe("whisper-1");
  });

  it("returns error for missing audioFilePath", async () => {
    const createTool = await loadTool();
    const tool = createTool({ sttService: { transcribe: vi.fn() } });
    await expect(
      tool.execute({}, new AbortController().signal),
    ).rejects.toThrow(/audioFilePath is required/i);
  });
});

// ─── TOOL-07: Docker ───

describe("createFridayAgentDockerTool", () => {
  async function loadTool() {
    const { createFridayAgentDockerTool } = await import(
      "../../../../src/agent/tools/friday-agent-docker-tool.js"
    );
    return createFridayAgentDockerTool;
  }

  function mockDockerService() {
    return {
      listContainers: vi.fn(async () => [
        { id: "abc123", name: "web", image: "nginx:latest", status: "Up 2 hours", state: "running" as const, ports: ["80/tcp"], created: "2024-01-01" },
      ]),
      startContainer: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      getContainerLogs: vi.fn(async () => ({ containerId: "abc123", stdout: "access log...", stderr: "" })),
      execInContainer: vi.fn(async () => ({ exitCode: 0, stdout: "total 8", stderr: "" })),
      buildImage: vi.fn(async () => ({ imageId: "sha256:def456", tags: ["myapp:latest"] })),
      composeUp: vi.fn(async () => ({ services: ["web", "db"], status: "up" })),
      composeDown: vi.fn(async () => {}),
    };
  }

  it("lists containers", async () => {
    const createTool = await loadTool();
    const service = mockDockerService();
    const tool = createTool({ dockerService: service });
    const result = await tool.execute(
      { operation: "list" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(1);
    expect(parsed.containers[0].name).toBe("web");
  });

  it("starts a container", async () => {
    const createTool = await loadTool();
    const service = mockDockerService();
    const tool = createTool({ dockerService: service });
    const result = await tool.execute(
      { operation: "start", containerId: "abc123" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.started).toBe(true);
    expect(service.startContainer).toHaveBeenCalledWith("abc123", expect.anything());
  });

  it("gets container logs", async () => {
    const createTool = await loadTool();
    const service = mockDockerService();
    const tool = createTool({ dockerService: service });
    const result = await tool.execute(
      { operation: "logs", containerId: "abc123", tail: 50 },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.stdout).toContain("access log");
  });

  it("runs compose up", async () => {
    const createTool = await loadTool();
    const service = mockDockerService();
    const tool = createTool({ dockerService: service });
    const result = await tool.execute(
      { operation: "compose_up", composePath: "/app/docker-compose.yml" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.services).toEqual(["web", "db"]);
  });
});

// ─── TOOL-09: Data Analysis ───

describe("createFridayAgentDataAnalysisTool", () => {
  async function loadTool() {
    const { createFridayAgentDataAnalysisTool } = await import(
      "../../../../src/agent/tools/friday-agent-data-analysis-tool.js"
    );
    return createFridayAgentDataAnalysisTool;
  }

  it("analyzes CSV data", async () => {
    const createTool = await loadTool();
    const mockService = {
      analyze: vi.fn(async () => ({
        rowCount: 100,
        columnCount: 3,
        columns: [
          { name: "id", type: "numeric" as const, nonNull: 100, unique: 100, min: 1, max: 100, mean: 50.5, median: 50 },
          { name: "name", type: "string" as const, nonNull: 100, unique: 95 },
          { name: "age", type: "numeric" as const, nonNull: 98, unique: 40, min: 18, max: 65, mean: 35.2, median: 33 },
        ],
        sampleRows: [{ id: 1, name: "Alice", age: 30 }],
      })),
      transform: vi.fn(async () => "id,name,age\n1,Alice,30"),
    };
    const tool = createTool({ dataAnalysisService: mockService });
    const result = await tool.execute(
      { operation: "analyze", data: "id,name,age\n1,Alice,30\n2,Bob,25" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.rowCount).toBe(100);
    expect(parsed.columns).toHaveLength(3);
  });

  it("transforms data", async () => {
    const createTool = await loadTool();
    const mockService = {
      analyze: vi.fn(),
      transform: vi.fn(async () => "id,name\n1,Alice"),
    };
    const tool = createTool({ dataAnalysisService: mockService });
    const result = await tool.execute(
      { operation: "transform", data: "id,name,age\n1,Alice,30", expression: "select(id, name)" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.result).toContain("Alice");
  });
});

// ─── Database Connector (TOOL-02 service layer) ───

describe("FridayDatabaseConnector", () => {
  async function loadConnector() {
    const mod = await import("../../../../src/database/friday-database-connector.js");
    return mod;
  }

  it("validates read-only queries — rejects DROP", async () => {
    const { validateReadOnlyQuery } = await loadConnector();
    expect(() => validateReadOnlyQuery("DROP TABLE users")).toThrow(/DROP/);
  });

  it("validates read-only queries — allows SELECT", async () => {
    const { validateReadOnlyQuery } = await loadConnector();
    expect(() => validateReadOnlyQuery("SELECT * FROM users WHERE name = 'DROP'")).not.toThrow();
  });

  it("detects database type from connection string", async () => {
    const { detectDatabaseType } = await loadConnector();
    expect(detectDatabaseType("postgresql://localhost/mydb")).toBe("postgresql");
    expect(detectDatabaseType("postgres://localhost/mydb")).toBe("postgresql");
    expect(detectDatabaseType("mysql://localhost/mydb")).toBe("mysql");
    expect(detectDatabaseType("/path/to/database.db")).toBe("sqlite");
  });

  it("parses database connections JSON", async () => {
    const { parseDatabaseConnections } = await loadConnector();
    const result = parseDatabaseConnections(JSON.stringify({
      main: "postgresql://localhost/mydb",
      cache: "/tmp/cache.db",
    }));
    expect(result.main.type).toBe("postgresql");
    expect(result.cache.type).toBe("sqlite");
    expect(result.main.readOnly).toBe(true);
  });
});

// ─── Image Generate Service (TOOL-01 service layer) ───

describe("FridayImageGenerateService", () => {
  it("validates image prompt", async () => {
    const { validateImagePrompt } = await import("../../../../src/media/friday-image-generate-service.js");
    expect(() => validateImagePrompt("")).toThrow(/required/);
    expect(() => validateImagePrompt("   ")).toThrow(/required/);
    expect(() => validateImagePrompt("a cute cat")).not.toThrow();
  });

  it("validates image size", async () => {
    const { validateImageSize } = await import("../../../../src/media/friday-image-generate-service.js");
    expect(validateImageSize(undefined)).toBe("1024x1024");
    expect(validateImageSize("512x512")).toBe("512x512");
    expect(() => validateImageSize("999x999")).toThrow(/Invalid size/);
  });
});

// ─── STT Service (TOOL-06 service layer) ───

describe("FridaySttService", () => {
  it("validates audio file — rejects missing file", async () => {
    const { validateAudioFile } = await import("../../../../src/media/friday-stt-service.js");
    expect(() => validateAudioFile("")).toThrow(/required/);
    expect(() => validateAudioFile("/nonexistent/audio.mp3")).toThrow(/not found/);
  });

  it("validates audio format", async () => {
    const { validateAudioFile } = await import("../../../../src/media/friday-stt-service.js");
    const fs = await import("node:fs");
    const tmpFile = "/tmp/test-stt.xyz";
    fs.writeFileSync(tmpFile, "fake");
    try {
      expect(() => validateAudioFile(tmpFile)).toThrow(/Unsupported audio format/);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ─── Calendar Service (TOOL-05 service layer) ───

describe("FridayCalendarService", () => {
  it("validates date strings", async () => {
    const { validateDateString } = await import("../../../../src/calendar/friday-calendar-service.js");
    expect(() => validateDateString("2024-01-15T09:00:00Z", "startDate")).not.toThrow();
    expect(() => validateDateString("not-a-date", "startDate")).toThrow(/Invalid date/);
  });
});

// ─── Tool Registry Integration ───

describe("Tool registry — new tools registration", () => {
  async function loadRegistry() {
    const { createFridayAgentToolRegistry } = await import(
      "../../../../src/agent/tools/friday-agent-tool-registry.js"
    );
    return createFridayAgentToolRegistry;
  }

  it("registers image_generate when service is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      imageGenerateService: { generate: vi.fn() } as any,
    });
    expect(tools.some((t) => t.name === "image_generate")).toBe(true);
  });

  it("registers database_query when connector is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      databaseConnector: { listConnections: vi.fn(), query: vi.fn(), schema: vi.fn(), listTables: vi.fn() } as any,
    });
    expect(tools.some((t) => t.name === "database_query")).toBe(true);
  });

  it("registers pdf_process when extractFn is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      pdfExtractFn: vi.fn() as any,
    });
    expect(tools.some((t) => t.name === "pdf_process")).toBe(true);
  });

  it("registers email when service is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      emailService: { send: vi.fn(), list: vi.fn(), read: vi.fn(), search: vi.fn() } as any,
    });
    expect(tools.some((t) => t.name === "email")).toBe(true);
  });

  it("registers calendar when service is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      calendarService: { listEvents: vi.fn(), createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(), findFreeSlots: vi.fn() } as any,
    });
    expect(tools.some((t) => t.name === "calendar")).toBe(true);
  });

  it("registers stt when service is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      sttService: { transcribe: vi.fn() } as any,
    });
    expect(tools.some((t) => t.name === "stt")).toBe(true);
  });

  it("registers docker when service is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      dockerService: { listContainers: vi.fn() } as any,
    });
    expect(tools.some((t) => t.name === "docker")).toBe(true);
  });

  it("registers data_analysis when service is provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({
      dataAnalysisService: { analyze: vi.fn(), transform: vi.fn() } as any,
    });
    expect(tools.some((t) => t.name === "data_analysis")).toBe(true);
  });

  it("does not register new tools when services are not provided", async () => {
    const createRegistry = await loadRegistry();
    const tools = createRegistry({});
    const newToolNames = ["image_generate", "database_query", "pdf_process", "email", "calendar", "stt", "docker", "data_analysis"];
    for (const name of newToolNames) {
      expect(tools.some((t) => t.name === name)).toBe(false);
    }
  });
});
