import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayAgentXhsTool } from "#agent";
import type { XhsPageInteractions } from "#xhs";
import type { XhsSessionManager, XhsSessionRow } from "#xhs";

// ─── Mock helpers ───

function createMockPageInteractions(
  overrides?: Partial<XhsPageInteractions>,
): XhsPageInteractions {
  return {
    login: vi.fn().mockResolvedValue({
      status: "authenticated",
      message: "Login successful",
    }),
    search: vi.fn().mockResolvedValue([
      { title: "Test Post", author: "Author1", likes: "100", link: "/explore/abc123" },
      { title: "Another Post", author: "Author2", likes: "50", link: "/explore/def456" },
    ]),
    createPost: vi.fn().mockResolvedValue({
      status: "published",
      noteUrl: "https://www.xiaohongshu.com/explore/abc123",
      message: "Post published successfully",
    }),
    extractComments: vi.fn().mockResolvedValue([
      { author: "User1", content: "Great post!", likes: "10" },
      { author: "User2", content: "Thanks for sharing", likes: "5" },
    ]),
    checkLoginState: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockSessionManager(
  overrides?: Partial<XhsSessionManager>,
): XhsSessionManager {
  const mockSession: XhsSessionRow = {
    id: "xhs-default",
    account_name: "test-account",
    cookies_json: "[]",
    user_agent: "Mozilla/5.0 Test",
    last_used_at: "2026-02-20T09:00:00.000Z",
    created_at: "2026-02-20T08:00:00.000Z",
  };

  return {
    saveCookies: vi.fn(),
    loadCookies: vi.fn().mockReturnValue([]),
    isSessionValid: vi.fn().mockReturnValue(true),
    getSession: vi.fn().mockReturnValue(mockSession),
    deleteSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([mockSession]),
    touchSession: vi.fn(),
    ...overrides,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

// ─── Tests ───

describe("FridayAgentXhsTool", () => {
  let pages: XhsPageInteractions;
  let sessions: XhsSessionManager;

  beforeEach(() => {
    pages = createMockPageInteractions();
    sessions = createMockSessionManager();
  });

  // ─── Tool definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentXhsTool({
      pageInteractions: pages,
      sessionManager: sessions,
    });
    expect(tool.name).toBe("xhs");
    expect(tool.description).toContain("Xiaohongshu");
    expect(tool.parameters).toBeDefined();
  });

  // ─── Validation ───

  it("rejects missing action", async () => {
    const tool = createFridayAgentXhsTool({
      pageInteractions: pages,
      sessionManager: sessions,
    });
    await expect(tool.execute({}, signal())).rejects.toThrow("action is required");
  });

  it("rejects invalid action", async () => {
    const tool = createFridayAgentXhsTool({
      pageInteractions: pages,
      sessionManager: sessions,
    });
    const result = await tool.execute({ action: "explode" }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });

  // ─── Login action ───

  describe("login", () => {
    it("calls login and returns result", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute({ action: "login" }, signal());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.action).toBe("login");
      expect(parsed.status).toBe("authenticated");
      expect(pages.login).toHaveBeenCalledWith("xhs-default", "xhs-default", expect.any(AbortSignal));
    });

    it("uses custom sessionId", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      await tool.execute({ action: "login", sessionId: "my-session" }, signal());
      expect(pages.login).toHaveBeenCalledWith("my-session", "my-session", expect.any(AbortSignal));
    });
  });

  // ─── Search action ───

  describe("search", () => {
    it("returns search results", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        { action: "search", keyword: "travel" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.action).toBe("search");
      expect(parsed.keyword).toBe("travel");
      expect(parsed.resultCount).toBe(2);
      expect(parsed.results).toHaveLength(2);
    });

    it("passes maxResults to page interactions", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      await tool.execute(
        { action: "search", keyword: "food", maxResults: 5 },
        signal(),
      );
      expect(pages.search).toHaveBeenCalledWith("xhs-default", "food", 5, expect.any(AbortSignal));
    });

    it("defaults maxResults to 10", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      await tool.execute({ action: "search", keyword: "food" }, signal());
      expect(pages.search).toHaveBeenCalledWith("xhs-default", "food", 10, expect.any(AbortSignal));
    });

    it("rejects missing keyword", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute({ action: "search" }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("keyword is required");
    });
  });

  // ─── Post action ───

  describe("post", () => {
    it("creates a post and returns result", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        {
          action: "post",
          title: "My Post",
          content: "Hello world",
          images: ["/tmp/img1.jpg", "/tmp/img2.jpg"],
          tags: ["travel", "food"],
        },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.action).toBe("post");
      expect(parsed.status).toBe("published");
      expect(pages.createPost).toHaveBeenCalledWith(
        "xhs-default",
        "My Post",
        "Hello world",
        ["/tmp/img1.jpg", "/tmp/img2.jpg"],
        ["travel", "food"],
        expect.any(AbortSignal),
      );
    });

    it("rejects missing title", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        { action: "post", content: "body", images: ["/tmp/img.jpg"] },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("title is required");
    });

    it("rejects missing content", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        { action: "post", title: "Title", images: ["/tmp/img.jpg"] },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("content is required");
    });

    it("rejects empty images array", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        { action: "post", title: "Title", content: "Body", images: [] },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("At least one image");
    });

    it("rejects missing images", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        { action: "post", title: "Title", content: "Body" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("At least one image");
    });
  });

  // ─── Comments action ───

  describe("comments", () => {
    it("extracts comments from post URL", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        { action: "comments", postUrl: "https://www.xiaohongshu.com/explore/abc123" },
        signal(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.action).toBe("comments");
      expect(parsed.commentCount).toBe(2);
      expect(parsed.comments).toHaveLength(2);
    });

    it("rejects missing postUrl", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute({ action: "comments" }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("postUrl is required");
    });
  });

  // ─── Status action ───

  describe("status", () => {
    it("returns session status", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute({ action: "status" }, signal());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.action).toBe("status");
      expect(parsed.hasSession).toBe(true);
      expect(parsed.isValid).toBe(true);
      expect(parsed.accountName).toBe("test-account");
    });

    it("reports no session when none exists", async () => {
      const noSessionManager = createMockSessionManager({
        getSession: vi.fn().mockReturnValue(undefined),
        isSessionValid: vi.fn().mockReturnValue(false),
      });
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: noSessionManager,
      });
      const result = await tool.execute({ action: "status" }, signal());
      const parsed = JSON.parse(result.content);
      expect(parsed.hasSession).toBe(false);
      expect(parsed.isValid).toBe(false);
    });
  });

  // ─── Error handling ───

  describe("error handling", () => {
    it("catches and returns page interaction errors", async () => {
      const errorPages = createMockPageInteractions({
        search: vi.fn().mockRejectedValue(new Error("Network error")),
      });
      const tool = createFridayAgentXhsTool({
        pageInteractions: errorPages,
        sessionManager: sessions,
      });
      const result = await tool.execute(
        { action: "search", keyword: "test" },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Network error");
    });

    it("handles abort signal", async () => {
      const abortPages = createMockPageInteractions({
        login: vi.fn().mockRejectedValue(new Error("aborted")),
      });
      const tool = createFridayAgentXhsTool({
        pageInteractions: abortPages,
        sessionManager: sessions,
      });
      const result = await tool.execute({ action: "login" }, signal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("aborted");
    });
  });

  // ─── Default session ID ───

  describe("default sessionId", () => {
    it("uses xhs-default when sessionId not provided", async () => {
      const tool = createFridayAgentXhsTool({
        pageInteractions: pages,
        sessionManager: sessions,
      });
      const result = await tool.execute({ action: "status" }, signal());
      const parsed = JSON.parse(result.content);
      expect(parsed.sessionId).toBe("xhs-default");
      expect(sessions.getSession).toHaveBeenCalledWith("xhs-default");
    });
  });
});
