import { describe, expect, it } from "vitest";

import {
  classifyFridayConversationTurn,
  finalizeFridayConversationFocus,
  prepareFridayConversationTurn,
} from "#sessions";
import type {
  FridayEvidenceBlock,
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "#sessions";

function makeMessage(input: {
  sequence: number;
  role: "user" | "assistant";
  contentText: string;
  metadata?: Record<string, unknown>;
  toolCalls?: unknown[];
}): FridaySessionMessageRecord {
  return {
    id: `msg-${String(input.sequence)}`,
    sessionId: "session-1",
    sessionKey: "discord:default:test",
    sequence: input.sequence,
    role: input.role,
    content: input.contentText,
    contentText: input.contentText,
    tokenCount: 0,
    toolCalls: input.toolCalls,
    metadata: input.metadata ?? {},
    memoryExtractStatus: "skipped",
    occurredAt: "2026-03-15T10:00:00.000Z",
    createdAt: "2026-03-15T10:00:00.000Z",
    updatedAt: "2026-03-15T10:00:00.000Z",
  };
}

describe("friday-session-conversation-orchestrator", () => {
  const baseFocusState: FridaySessionConversationFocusState = {
    currentTopicFingerprint: "topic-1",
    currentTopicSummary: "Explain the capital of France and related geography.",
    currentTopicStartSequence: 1,
    lastAnsweredQuestion: "What is the capital of France?",
    lastAssistantAskedQuestion: false,
    lastRunId: "run-1",
    updatedAt: "2026-03-15T10:00:00.000Z",
  };

  it("classifies an unrelated question as a new topic", () => {
    expect(classifyFridayConversationTurn({
      task: "How do I bake sourdough bread?",
      focusState: baseFocusState,
    })).toBe("new_topic");
  });

  it("classifies explicit final-result questions as status checks", () => {
    expect(classifyFridayConversationTurn({
      task: "What is the final result now?",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Use a subagent to say exactly CHILD_OK and then report the result.",
      },
    })).toBe("status_check");
  });

  it("keeps only the active topic window for follow-up turns", () => {
    const prepared = prepareFridayConversationTurn({
      task: "What country is that city in?",
      focusState: baseFocusState,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What is the capital of France?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Paris is the capital of France." }),
        makeMessage({ sequence: 3, role: "user", contentText: "Explain it briefly." }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Paris is in north-central France." }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.historyMessages).toHaveLength(4);
    expect(prepared.taskPrompt).toContain("Referenced assistant fact:");
    expect(prepared.selectedBlocks.length).toBeGreaterThan(0);
  });

  it("anchors recall questions to a prior 'remember this code phrase' user turn", () => {
    const prepared = prepareFridayConversationTurn({
      task: "What code phrase did I ask you to remember? Reply with the phrase only.",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Remember this code phrase for this conversation only: amber-cascade-17.",
        currentTopicStartSequence: 1,
      },
      currentUserSequence: 3,
      historyRecords: [
        makeMessage({
          sequence: 1,
          role: "user",
          contentText: "Remember this code phrase for this conversation only: amber-cascade-17. Reply with OK only.",
        }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "OK" }),
      ],
    });

    const historyText = prepared.historyMessages
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .join("\n");
    expect(prepared.turnKind).not.toBe("status_check");
    expect(historyText).toContain("amber-cascade-17");
    expect(prepared.taskPrompt).toContain("amber-cascade-17");
  });

  it("drops prior content history for a new topic", () => {
    const prepared = prepareFridayConversationTurn({
      task: "How do I bake sourdough bread?",
      focusState: baseFocusState,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What is the capital of France?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Paris is the capital of France." }),
        makeMessage({ sequence: 3, role: "user", contentText: "Explain it briefly." }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Paris is in north-central France." }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: How do I bake sourdough bread?");
  });

  it("anchors recent-result follow-ups to the immediately previous timed-out task and partial tool evidence", () => {
    const prepared = prepareFridayConversationTurn({
      task: "刚刚找到了什么？",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "去示例目录网站上找 5550100199 这个号码相关的所有信息",
        currentTopicStartSequence: 3,
        assistantAnchorSummary: "Agent run timed out",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({
          sequence: 1,
          role: "user",
          contentText: "把 SampleBoard 做成一个 Friday skill",
        }),
        makeMessage({
          sequence: 2,
          role: "assistant",
          contentText: "我查看了 SampleBoard，并准备生成 skill。",
        }),
        makeMessage({
          sequence: 3,
          role: "user",
          contentText: "去示例目录网站上去找5550100199这个号码相关的所有信息",
        }),
        makeMessage({
          sequence: 4,
          role: "assistant",
          contentText: "Agent run timed out",
          toolCalls: [
            {
              toolName: "web_fetch",
              args: { url: "https://example.test/search/5550100199" },
              result: {
                content: "HTTP 200 OK\nExtracted text: 5550100199，示例目录搜索结果，公开列表，测试数据",
              },
            },
            {
              toolName: "web_fetch",
              args: { url: "https://www.us168168.com/" },
              result: { content: "HTTP 403 Forbidden\nAttention Required! | Cloudflare" },
            },
          ],
        }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.turnFrame.intent).toBe("result_recall");
    expect(prepared.turnFrame.referent.type).toBe("last_run");
    expect(prepared.selectedBlocks[0]?.id).toContain("recent-result:");
    expect(prepared.selectedBlocks[0]?.summary).toContain("5550100199");
    expect(prepared.selectedBlocks[0]?.summary).toContain("example.test/search/5550100199");
    expect(prepared.selectedBlocks[0]?.summary).not.toContain("SampleBoard");
    expect(prepared.taskPrompt).toContain("immediately previous task");
    expect(prepared.taskPrompt).toContain("Do not switch to durable memory");
    expect(prepared.historyMessages).toEqual([
      { role: "user", content: "去示例目录网站上去找5550100199这个号码相关的所有信息" },
      { role: "assistant", content: "Agent run timed out" },
    ]);
  });

  it("treats cancellation-before-result questions as recent-result follow-ups", () => {
    expect(classifyFridayConversationTurn({
      task: "取消前找到了什么？",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "搜索示例目录上的号码信息",
        assistantAnchorSummary: "请求已取消：Agent run timed out",
      },
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "搜索示例目录上的号码信息" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "请求已取消：Agent run timed out" }),
      ],
      currentUserSequence: 3,
    })).toBe("follow_up");
  });

  it("treats runtime setting questions as config questions and blocks stale timeout anchors", () => {
    const prepared = prepareFridayConversationTurn({
      task: "agent run的设定的是多少",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "刚刚找到了什么？",
        currentTopicStartSequence: 88,
        assistantAnchorSummary: "我找到了以下关于 555-010-0199 的信息",
        lastAssistantAskedQuestion: true,
        lastRunId: "run-phone",
      },
      currentUserSequence: 7,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "把 SampleBoard 做成一个 Friday skill" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "我查看了 SampleBoard，并准备生成 skill。" }),
        makeMessage({ sequence: 3, role: "user", contentText: "去示例目录网站上找5550100199这个号码相关信息" }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Agent run timed out" }),
        makeMessage({ sequence: 5, role: "user", contentText: "刚刚找到了什么？" }),
        makeMessage({ sequence: 6, role: "assistant", contentText: "我找到了以下关于 555-010-0199 的信息" }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.turnFrame.intent).toBe("config_question");
    expect(prepared.turnFrame.referent.type).toBe("none");
    expect(prepared.selectedBlocks).toEqual([]);
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("configuration value");
    expect(prepared.taskPrompt).not.toContain("626");
    expect(prepared.taskPrompt).not.toContain("SampleBoard");
    expect(prepared.selectionReasons).toEqual([
      "turn_frame -> config_question selected no prior task blocks; answer the configuration question from deterministic retrieval or current code only.",
    ]);
  });

  it("treats explicit literal response requests as new turns instead of stale follow-ups", () => {
    const prepared = prepareFridayConversationTurn({
      task: "请只回复：green-771",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "请只回复：chat ok",
        currentTopicStartSequence: 3,
        assistantAnchorSummary: "chat ok",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "hi" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "你好！有什么我可以帮助你的吗？" }),
        makeMessage({ sequence: 3, role: "user", contentText: "请只回复：chat ok" }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "chat ok" }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: 请只回复：green-771");
    expect(prepared.taskPrompt).not.toContain("Continue the current topic");
    expect(prepared.taskPrompt).not.toContain("chat ok");
  });

  it("treats explicit topic switches as new topics even with one overlapping memory token", () => {
    const prepared = prepareFridayConversationTurn({
      task: "换个话题：用一句话说说今天是星期几，不要提暗号。",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "请记住：本轮闭环测试的暗号是 松针-4729。之后我可能只说“那个暗号”来问你。",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "已记住。",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({
          sequence: 1,
          role: "user",
          contentText: "请记住：本轮闭环测试的暗号是 松针-4729。之后我可能只说“那个暗号”来问你。",
        }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "已记住。" }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.selectedBlocks).toEqual([]);
    expect(prepared.taskPrompt).toContain("explicitly switched away from the prior topic");
    expect(prepared.taskPrompt).toContain("Do not mention, restate, or continue the previous topic");
    expect(prepared.taskPrompt).not.toContain("松针-4729");
  });

  it("treats literal-format recall requests as anchored follow-ups, not standalone literal turns", () => {
    const prepared = prepareFridayConversationTurn({
      task: "刚刚那个暗号是什么？只回复暗号。",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "请记住：本轮闭环测试的暗号是 松针-4729。之后我可能只说“那个暗号”来问你。",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "已记住。",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({
          sequence: 1,
          role: "user",
          contentText: "请记住：本轮闭环测试的暗号是 松针-4729。之后我可能只说“那个暗号”来问你。",
        }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "已记住。" }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks.some((block) => block.source === "focus_topic")).toBe(true);
    expect(prepared.taskPrompt).toContain("tightly formatted answer from referenced context");
    expect(prepared.taskPrompt).toContain("松针-4729");
    expect(prepared.taskPrompt).toContain("Respect the latest user's output-format constraint exactly");
    expect(prepared.taskPrompt).not.toContain("Do not reuse previous user text");
  });

  it("recalls earlier facts after an explicit topic switch without reusing the switch topic", () => {
    const prepared = prepareFridayConversationTurn({
      task: "刚刚那个暗号是什么？只回复暗号。",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "换个话题：用一句话说说今天是星期几，不要提暗号。",
        currentTopicStartSequence: 3,
        assistantAnchorSummary: "今天是星期二。",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({
          sequence: 1,
          role: "user",
          contentText: "请记住：本轮闭环测试的暗号是 松针-4729。之后我可能只说“那个暗号”来问你。",
        }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "已记住。" }),
        makeMessage({
          sequence: 3,
          role: "user",
          contentText: "换个话题：用一句话说说今天是星期几，不要提暗号。",
        }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "今天是星期二。" }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks[0]?.source).toBe("conversation_block");
    expect(prepared.selectedBlocks[0]?.summary).toContain("松针-4729");
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("不要提暗号"))).toBe(false);
    expect(prepared.taskPrompt).toContain("tightly formatted answer from referenced context");
    expect(prepared.taskPrompt).toContain("松针-4729");
    expect(prepared.taskPrompt).not.toContain("今天是星期二");
  });

  it("treats bare field recall questions as recall and ignores negative field mentions", () => {
    const prepared = prepareFridayConversationTurn({
      task: "FRIDAY-CODEX-LIVE-UI-12：少关键词测试：暗号？只回复暗号。",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "FRIDAY-CODEX-LIVE-UI-11：随机换个话题：给我一个不超过8字的项目代号，只回复代号，不要提暗号。",
        currentTopicStartSequence: 9,
        assistantAnchorSummary: "青鸾-7214",
      },
      currentUserSequence: 11,
      historyRecords: [
        makeMessage({
          sequence: 1,
          role: "user",
          contentText: "请记住这次 Feishu 真链路测试暗号「青杉-6184」，只回复“已记住”。",
        }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "已记住。" }),
        makeMessage({
          sequence: 3,
          role: "user",
          contentText: "刚刚那个暗号是什么？只回复暗号。",
        }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Your codename is unrelated approval text." }),
        makeMessage({
          sequence: 5,
          role: "user",
          contentText: "请记住这次修复复测暗号「雪松-9307」，只回复“已记住”。",
        }),
        makeMessage({ sequence: 6, role: "assistant", contentText: "已记住。" }),
        makeMessage({
          sequence: 7,
          role: "user",
          contentText: "换个话题：用一句话说说今天是星期几，不要提暗号。",
        }),
        makeMessage({ sequence: 8, role: "assistant", contentText: "今天是星期二。" }),
        makeMessage({
          sequence: 9,
          role: "user",
          contentText: "FRIDAY-CODEX-LIVE-UI-11：随机换个话题：给我一个不超过8字的项目代号，只回复代号，不要提暗号。",
        }),
        makeMessage({ sequence: 10, role: "assistant", contentText: "青鸾-7214" }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks[0]?.summary).toContain("雪松-9307");
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("青杉-6184"))).toBe(false);
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("Your codename"))).toBe(false);
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("不要提暗号"))).toBe(false);
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("青鸾-7214"))).toBe(false);
    expect(prepared.taskPrompt).toContain("雪松-9307");
    expect(prepared.taskPrompt).not.toContain("青杉-6184");
    expect(prepared.taskPrompt).not.toContain("Your codename");
    expect(prepared.taskPrompt).not.toContain("青鸾-7214");
  });

  it("prefers the newest recallable fact over prior recall-question blocks", () => {
    const prepared = prepareFridayConversationTurn({
      task: "FRIDAY-CODEX-LIVE-UI-09：刚刚那个暗号是什么？只回复暗号。",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "换个话题：用一句话说说今天是星期几，不要提暗号。",
        currentTopicStartSequence: 13,
        assistantAnchorSummary: "今天是星期二。",
      },
      currentUserSequence: 15,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "帮我比较一下 Omi 和 Notion AI 的记录方式。" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Omi 可以加入 Friday 的模块包括实时音频、会话摘要和知识库整理。" }),
        makeMessage({ sequence: 3, role: "user", contentText: "再换个问题：SampleBoard 里有哪些素材生成入口？" }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "SampleBoard 里有小红书、漫画选题、素材管理等入口。" }),
        makeMessage({ sequence: 5, role: "user", contentText: "先问一个代码问题：workflow runner 为什么要记录 state？" }),
        makeMessage({ sequence: 6, role: "assistant", contentText: "因为 runner 需要在中断后恢复进度并避免重复执行。" }),
        makeMessage({
          sequence: 7,
          role: "user",
          contentText: "请记住这次 Feishu 真链路测试暗号「青杉-6184」，只回复“已记住”。",
        }),
        makeMessage({ sequence: 8, role: "assistant", contentText: "已记住。" }),
        makeMessage({
          sequence: 9,
          role: "user",
          contentText: "刚刚那个暗号是什么？只回复暗号。",
        }),
        makeMessage({ sequence: 10, role: "assistant", contentText: "Your codename is unrelated approval text." }),
        makeMessage({
          sequence: 11,
          role: "user",
          contentText: "请记住这次修复复测暗号「雪松-9307」，只回复“已记住”。",
        }),
        makeMessage({ sequence: 12, role: "assistant", contentText: "已记住。" }),
        makeMessage({
          sequence: 13,
          role: "user",
          contentText: "换个话题：用一句话说说今天是星期几，不要提暗号。",
        }),
        makeMessage({ sequence: 14, role: "assistant", contentText: "今天是星期二。" }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks[0]?.summary).toContain("雪松-9307");
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("Your codename"))).toBe(false);
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("青杉-6184"))).toBe(false);
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("Omi"))).toBe(false);
    expect(prepared.historyMessages.some((message) =>
      typeof message.content === "string" && message.content.includes("Your codename"))).toBe(false);
    expect(prepared.taskPrompt).toContain("雪松-9307");
    expect(prepared.taskPrompt).not.toContain("Your codename");
  });

  it("treats single-letter option replies as clarification anchored to the latest assistant choice prompt", () => {
    const prepared = prepareFridayConversationTurn({
      task: "A",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Create a reusable session summarizer skill for Friday.",
        currentTopicStartSequence: 1,
        lastAssistantAskedQuestion: false,
      },
      currentUserSequence: 3,
      historyRecords: [
        makeMessage({
          sequence: 1,
          role: "user",
          contentText: "要我直接写这个 skill 吗？",
        }),
        makeMessage({
          sequence: 2,
          role: "assistant",
          contentText: "方案 A：用 skill_generate 工具走完整生成流程。方案 B：直接写 skill 文件。你偏好哪个？方便我立即继续。",
        }),
      ],
    });

    expect(prepared.turnKind).toBe("clarification");
    expect(prepared.selectedBlocks.some((block) => block.source === "assistant_anchor")).toBe(true);
    expect(prepared.historyMessages.some((message) =>
      message.role === "assistant"
      && typeof message.content === "string"
      && message.content.includes("方案 A"))).toBe(true);
    expect(prepared.taskPrompt).toContain("replying to your clarification request");
    expect(prepared.taskPrompt).toContain("方案 A");
    expect(prepared.taskPrompt).not.toContain("A previous topic exists");
  });

  it("treats option replies with follow-on instructions as anchored clarification and suppresses stale topic windows", () => {
    const staleHistory: FridaySessionMessageRecord[] = [
      makeMessage({ sequence: 1, role: "user", contentText: "你好" }),
      makeMessage({ sequence: 2, role: "assistant", contentText: "你好，我是 Friday。" }),
      ...Array.from({ length: 36 }, (_, index) => {
        const sequence = index + 3;
        return makeMessage({
          sequence,
          role: sequence % 2 === 1 ? "user" : "assistant",
          contentText: sequence % 2 === 1
            ? `旧话题 filler ${String(sequence)}`
            : `旧回复 filler ${String(sequence)}`,
        });
      }),
      makeMessage({
        sequence: 39,
        role: "user",
        contentText: "把 SampleBoard 的功能搬过来做成 Friday skill。",
      }),
      makeMessage({
        sequence: 40,
        role: "assistant",
        contentText: [
          "几个选项：",
          "1. 小红书创作工作流",
          "2. 漫步选题",
          "3. RedClaw 自动化",
          "4. 全部打包成一个 skill，然后做成 workflow",
          "你选哪个？",
        ].join("\n"),
      }),
    ];

    const prepared = prepareFridayConversationTurn({
      task: "4，然后做成一个workflow，我打开和调整后可以直接去自动化做任务",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "你好",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "你好，我是 Friday。",
      },
      currentUserSequence: 41,
      historyRecords: staleHistory,
    });

    expect(prepared.turnKind).toBe("clarification");
    expect(prepared.selectedBlocks.some((block) => block.source === "assistant_anchor")).toBe(true);
    expect(prepared.selectedBlocks.some((block) => block.id.startsWith("topic-window:"))).toBe(false);
    expect(prepared.currentTopicSummary).toContain("全部打包成一个 skill");
    expect(prepared.taskPrompt).toContain("replying to your clarification request");
    expect(prepared.taskPrompt).toContain("4. 全部打包成一个 skill");
    expect(prepared.taskPrompt).not.toContain("Current topic: 你好");
    expect(prepared.taskPrompt).not.toContain("旧话题 filler");
  });

  it("classifies short follow-ups against the latest assistant answer", () => {
    const prepared = prepareFridayConversationTurn({
      task: "为什么没有connect",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        assistantAnchorSummary: "The desktop companion is not connected.",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "看一下我桌面上的codex app给我的回复是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "I cannot inspect it because the desktop companion is not connected." }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks.some((block) => block.source === "assistant_anchor")).toBe(true);
    expect(prepared.taskPrompt).toContain("Referenced assistant fact:");
    expect(prepared.taskPrompt).toContain("desktop companion is not connected");
    expect(prepared.taskPrompt).toContain("Do not claim a new action");
  });

  it("keeps a short why-question on the same topic even when the latest assistant anchor uses different wording", () => {
    const prepared = prepareFridayConversationTurn({
      task: "为什么没有connect",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        assistantAnchorSummary: "当前桌面上的 Codex 应用程序无法列出通知，状态为不可用。",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "看一下我桌面上的codex app给我的回复是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "当前桌面上的 Codex 应用程序无法列出通知，状态为不可用。" }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact:");
    expect(prepared.taskPrompt).toContain("Codex 应用程序无法列出通知");
  });

  it("stores assistant-anchor summaries as assistant facts instead of full user-assistant windows", () => {
    const prepared = prepareFridayConversationTurn({
      task: "这里",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "看一下我桌面上的codex app给我的回复是什么",
        assistantAnchorSummary: "The desktop companion is not connected.",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "看一下我桌面上的codex app给我的回复是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "The desktop companion is not connected." }),
      ],
    });

    const assistantAnchor = prepared.selectedBlocks.find((block) => block.source === "assistant_anchor");
    expect(assistantAnchor?.summary).toBe("The desktop companion is not connected.");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact: The desktop companion is not connected.");
  });

  it("resolves reply anchors from platform source message ids", () => {
    const prepared = prepareFridayConversationTurn({
      task: "这里",
      focusState: baseFocusState,
      currentUserSequence: 5,
      replyToMessageId: "discord-msg-2",
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "Open GitHub" }),
        makeMessage({
          sequence: 2,
          role: "assistant",
          contentText: "I could not open it because the browser was not connected.",
          metadata: { sourceMessageId: "discord-msg-2" },
        }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.replyAnchorMessageId).toBe("msg-2");
    expect(prepared.selectedBlocks[0]?.source).toBe("reply_anchor");
  });

  it("treats short explanation requests as follow-ups to the latest assistant answer", () => {
    const prepared = prepareFridayConversationTurn({
      task: "简单解释一下",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "图片文件不能在本地工作区中找到，image_key 是聊天系统里的图片引用。",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "图片文件不能在本地工作区中找到，image_key 是聊天系统里的图片引用。",
      },
      currentUserSequence: 6,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "这是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "图片文件不能在本地工作区中找到，image_key 是聊天系统里的图片引用。" }),
        makeMessage({ sequence: 3, role: "user", contentText: "你的安全机制是什么" }),
        makeMessage({
          sequence: 4,
          role: "assistant",
          contentText: "Friday 的安全机制包括能力分级控制、破坏性操作审批门、只读模式保护。",
        }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks[0]?.source).toBe("assistant_anchor");
    expect(prepared.historyMessages.some((message) =>
      message.role === "assistant"
      && typeof message.content === "string"
      && message.content.includes("安全机制"))).toBe(true);
    expect(prepared.taskPrompt).toContain("Referenced assistant fact:");
    expect(prepared.taskPrompt).toContain("安全机制");
    expect(prepared.taskPrompt).not.toContain("image_key");
  });

  it("treats substantive Chinese questions as new topics despite stale deictic focus", () => {
    const prepared = prepareFridayConversationTurn({
      task: "你的安全机制是什么",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "图片文件不能在本地工作区中找到，image_key 是聊天系统里的图片引用。",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "图片文件不能在本地工作区中找到，image_key 是聊天系统里的图片引用。",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "这是什么" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "图片文件不能在本地工作区中找到，image_key 是聊天系统里的图片引用。" }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: 你的安全机制是什么");
    expect(prepared.taskPrompt).not.toContain("image_key");
  });

  it("falls back unresolved platform reply anchors to the latest assistant answer", () => {
    const prepared = prepareFridayConversationTurn({
      task: "简单解释一下",
      focusState: baseFocusState,
      currentUserSequence: 5,
      replyToMessageId: "lark-message-not-yet-mirrored",
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "你的安全机制是什么" }),
        makeMessage({
          sequence: 2,
          role: "assistant",
          contentText: "Friday 遇到敏感操作会先说明风险，然后等待 allowlist 用户审批。",
        }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.replyAnchorMessageId).toBeUndefined();
    expect(prepared.selectedBlocks[0]?.source).toBe("assistant_anchor");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact:");
    expect(prepared.taskPrompt).toContain("敏感操作");
  });

  it("treats a bare punctuation nudge as referring to the immediately previous user message", () => {
    const prepared = prepareFridayConversationTurn({
      task: "？",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "图片文件不能在本地工作区中找到，image_key 是聊天系统里的图片引用。",
        currentTopicStartSequence: 1,
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "assistant", contentText: "我无法直接读取这张图片。" }),
        makeMessage({ sequence: 2, role: "user", contentText: "你没有办法看到你发给我的信息没" }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks[0]?.source).toBe("recent_user");
    expect(prepared.taskPrompt).toContain("immediately previous message");
    expect(prepared.taskPrompt).toContain("你没有办法看到你发给我的信息没");
    expect(prepared.taskPrompt).not.toContain("image_key");
  });

  it("builds an anchored follow-up prompt even without persisted focus state", () => {
    const prepared = prepareFridayConversationTurn({
      task: "why didn't it connect/open?",
      currentUserSequence: 5,
      replyToMessageId: "discord-msg-2",
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "open github" }),
        makeMessage({
          sequence: 2,
          role: "assistant",
          contentText: "I could not open GitHub because the browser session was not connected.",
          metadata: { sourceMessageId: "discord-msg-2" },
        }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.taskPrompt).toContain("following up on a specifically referenced earlier exchange");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact: I could not open GitHub because the browser session was not connected.");
    expect(prepared.taskPrompt).toContain("Relevant anchors");
    expect(prepared.taskPrompt).toContain("Do not claim a new action, a new success state, or a new result");
  });

  it("treats explicit progress checks as status_check and avoids prior answer history", () => {
    const prepared = prepareFridayConversationTurn({
      task: "刚才那个任务现在进度怎么样？",
      focusState: baseFocusState,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "Open Facebook and sign up." }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "I delegated the task to a browser worker." }),
      ],
    });

    expect(prepared.turnKind).toBe("status_check");
    expect(prepared.historyMessages).toHaveLength(2);
    expect(prepared.taskPrompt).toContain("asking for a status update");
    expect(prepared.taskPrompt).toContain("Use the task_status tool before answering.");
  });

  it("treats Chinese result follow-ups as status_check", () => {
    const prepared = prepareFridayConversationTurn({
      task: "那个任务结果呢？",
      focusState: {
        ...baseFocusState,
        pendingPlanRunId: "run-plan-1",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "create a new workflow that watches release blockers and posts a summary to Slack every weekday morning" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Before I execute this major decision, I need one detail to make sure the direction is correct." }),
      ],
    });

    expect(prepared.turnKind).toBe("status_check");
    expect(prepared.taskPrompt).toContain("asking for a status update");
    expect(prepared.taskPrompt).toContain("Pending plan run: run-plan-1");
  });

  it("treats cancelled-request follow-ups as status_check instead of new topics", () => {
    const prepared = prepareFridayConversationTurn({
      task: "为什么 Request was cancelled before completion?",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Generate a social media promotion plan for Friday.",
        lastRunId: "run-promote-1",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "帮我做 Friday 的社交媒体推广方案" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Still working on your request after 30s. Phase: executing" }),
      ],
    });

    expect(prepared.turnKind).toBe("status_check");
    expect(prepared.taskPrompt).toContain("asking for a status update");
    expect(prepared.taskPrompt).toContain("Use the task_status tool before answering.");
    expect(prepared.taskPrompt).not.toContain("A previous topic exists");
  });

  it("selects deterministic evidence blocks for status questions", () => {
    const evidenceBlocks: FridayEvidenceBlock[] = [
      {
        id: "evidence:task-status",
        source: "task_status_block",
        summary: "run run-2; status running; phase executing; latest tool browser",
        score: 125,
        reason: "Deterministic task status snapshot selected for a status/progress/result question.",
      },
      {
        id: "evidence:run-activity",
        source: "run_event_block",
        summary: "latest phase executing; latest tool browser; elapsed 12s",
        score: 114,
        reason: "Latest run activity derived from deterministic run-event-backed task status.",
      },
    ];

    const prepared = prepareFridayConversationTurn({
      task: "你现在在做什么？",
      focusState: baseFocusState,
      currentUserSequence: 3,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "Open Facebook and sign up." }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "I delegated the task to a browser worker." }),
      ],
      evidenceBlocks,
    });

    expect(prepared.turnKind).toBe("status_check");
    expect(prepared.selectedBlocks.some((block) => block.source === "task_status_block")).toBe(true);
    expect(prepared.selectedBlocks.some((block) => block.source === "run_event_block")).toBe(true);
    expect(prepared.taskPrompt).toContain("[task_status_block] run run-2; status running; phase executing; latest tool browser");
  });

  it("does not treat workflow requirements containing release status as a status check", () => {
    const prepared = prepareFridayConversationTurn({
      task: "Generate a workflow that runs every Friday, collects workspace release status, posts the summary to Slack, keeps the execution read-only, and reports blockers before deployment.",
      focusState: undefined,
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What is the capital of France?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Paris is the capital of France." }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.taskPrompt).toContain("Generate a workflow that runs every Friday");
    expect(prepared.taskPrompt).not.toContain("asking for a status update");
  });

  it("keeps recent cross-topic history for recap-style follow ups", () => {
    const prepared = prepareFridayConversationTurn({
      task: "Summarize your recommendations",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "What test runner do you recommend?",
        currentTopicStartSequence: 3,
      },
      currentUserSequence: 6,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What language do you prefer?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "I like TypeScript." }),
        makeMessage({ sequence: 3, role: "user", contentText: "What test runner do you recommend?" }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Vitest is my recommended test runner." }),
        makeMessage({ sequence: 5, role: "user", contentText: "Thanks." }),
      ],
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.historyMessages).toHaveLength(5);
  });

  it("rehydrates relevant earlier history blocks for long follow-up conversations", () => {
    const historyRecords: FridaySessionMessageRecord[] = [
      makeMessage({ sequence: 1, role: "user", contentText: "Open GitHub in the browser." }),
      makeMessage({ sequence: 2, role: "assistant", contentText: "I could not open GitHub because the browser session was not connected." }),
      makeMessage({ sequence: 3, role: "user", contentText: "What does the error imply?" }),
      makeMessage({ sequence: 4, role: "assistant", contentText: "It implies the browser bridge was unavailable." }),
      makeMessage({ sequence: 5, role: "user", contentText: "How should we test the fix?" }),
      makeMessage({ sequence: 6, role: "assistant", contentText: "Run a smoke test after reconnecting the browser session." }),
      makeMessage({ sequence: 7, role: "user", contentText: "Should we also check Discord?" }),
      makeMessage({ sequence: 8, role: "assistant", contentText: "Yes, verify Discord notifications after the browser smoke test." }),
      makeMessage({ sequence: 9, role: "user", contentText: "What about logging?" }),
      makeMessage({ sequence: 10, role: "assistant", contentText: "Capture logs before and after reconnecting." }),
      makeMessage({ sequence: 11, role: "user", contentText: "Summarize the rollout order." }),
      makeMessage({ sequence: 12, role: "assistant", contentText: "Reconnect browser, rerun smoke, verify Discord, then inspect logs." }),
      makeMessage({ sequence: 13, role: "user", contentText: "Do we need screenshots?" }),
      makeMessage({ sequence: 14, role: "assistant", contentText: "Yes, collect screenshots for the regression report." }),
      makeMessage({ sequence: 15, role: "user", contentText: "Anything else?" }),
      makeMessage({ sequence: 16, role: "assistant", contentText: "That covers the rollout checklist." }),
    ];

    const prepared = prepareFridayConversationTurn({
      task: "why didn't it connect/open?",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Open GitHub in the browser and understand why it failed to connect.",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "That covers the rollout checklist.",
      },
      currentUserSequence: 17,
      historyRecords,
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks.some((block) => block.source === "tool_failure_block")).toBe(true);
    expect(prepared.historyMessages.some((message) =>
      message.role === "assistant"
      && typeof message.content === "string"
      && message.content.includes("browser session was not connected"))).toBe(true);
    expect(prepared.taskPrompt).toContain("tool_failure_block");
  });

  it("does not let compacted older blocks pollute a new topic", () => {
    const historyRecords: FridaySessionMessageRecord[] = Array.from({ length: 16 }, (_, index) => {
      const sequence = index + 1;
      return makeMessage({
        sequence,
        role: sequence % 2 === 1 ? "user" : "assistant",
        contentText: sequence % 2 === 1
          ? `Discuss browser rollout step ${String(sequence)}`
          : `Assistant rollout answer ${String(sequence)} about reconnecting the browser.`,
      });
    });

    const prepared = prepareFridayConversationTurn({
      task: "How do I bake sourdough bread?",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Open GitHub in the browser and understand why it failed to connect.",
        currentTopicStartSequence: 1,
      },
      currentUserSequence: 17,
      historyRecords,
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: How do I bake sourdough bread?");
    expect(prepared.taskPrompt).toContain("previous topic exists");
    expect(prepared.taskPrompt).not.toContain("Open GitHub");
  });

  it("prefers the relevant older compacted block over the latest topic window when a long follow-up names an older entity", () => {
    const historyRecords: FridaySessionMessageRecord[] = [
      makeMessage({ sequence: 1, role: "user", contentText: "Answer exactly: The GitHub issue was browser not connected." }),
      makeMessage({ sequence: 2, role: "assistant", contentText: "The GitHub issue was browser not connected." }),
      ...Array.from({ length: 20 }, (_, index) => {
        const sequence = index + 3;
        return makeMessage({
          sequence,
          role: sequence % 2 === 1 ? "user" : "assistant",
          contentText: sequence % 2 === 1
            ? `Reply with exactly FILLER_${String(Math.ceil((sequence - 2) / 2)).padStart(2, "0")}.`
            : `FILLER_${String(Math.ceil((sequence - 2) / 2)).padStart(2, "0")}.`,
        });
      }),
      makeMessage({ sequence: 23, role: "user", contentText: "Answer exactly: Oranges are orange." }),
      makeMessage({ sequence: 24, role: "assistant", contentText: "Oranges are orange." }),
    ];

    const prepared = prepareFridayConversationTurn({
      task: "What was wrong with that GitHub thing? Answer in one short sentence.",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Answer exactly: Oranges are orange.",
        currentTopicStartSequence: 23,
        assistantAnchorSummary: "Oranges are orange.",
      },
      currentUserSequence: 25,
      historyRecords,
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.historyMessages.some((message) =>
      message.role === "assistant"
      && typeof message.content === "string"
      && message.content.includes("GitHub issue was browser not connected"))).toBe(true);
    expect(prepared.selectedBlocks.some((block) =>
      (block.source === "tool_failure_block" || block.source === "topic_block" || block.source === "conversation_block")
      && block.summary.includes("GitHub issue was browser not connected"))).toBe(true);
    expect(prepared.selectedBlocks.some((block) =>
      block.source === "focus_topic" && block.summary.includes("Oranges are orange"))).toBe(false);
    expect(prepared.taskPrompt).not.toContain("Continue the current topic: Answer exactly: Oranges are orange.");
    expect(prepared.taskPrompt).toContain("earlier referenced session context");
  });

  it("does not let the current topic window pollute an explicit reply anchor follow-up", () => {
    const historyRecords: FridaySessionMessageRecord[] = [
      makeMessage({ sequence: 1, role: "user", contentText: "Answer exactly: The GitHub issue was browser not connected." }),
      makeMessage({
        sequence: 2,
        role: "assistant",
        contentText: "The GitHub issue was browser not connected.",
        metadata: { sourceMessageId: "discord-msg-2" },
      }),
      ...Array.from({ length: 24 }, (_, index) => {
        const sequence = index + 3;
        return makeMessage({
          sequence,
          role: sequence % 2 === 1 ? "user" : "assistant",
          contentText: sequence === 27
            ? "How do I bake sourdough bread? Answer in one short sentence."
            : sequence === 28
              ? "To bake sourdough bread, combine flour, water, salt, and your active sourdough starter, then ferment, shape, and bake the dough."
              : sequence % 2 === 1
                ? `Reply with exactly FILLER_${String(Math.ceil((sequence - 2) / 2)).padStart(2, "0")}.`
                : `FILLER_${String(Math.ceil((sequence - 2) / 2)).padStart(2, "0")}.`,
        });
      }),
    ];

    const prepared = prepareFridayConversationTurn({
      task: "that one",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "How do I bake sourdough bread? Answer in one short sentence.",
        currentTopicStartSequence: 27,
        assistantAnchorSummary: "To bake sourdough bread, combine flour, water, salt, and your active sourdough starter, then ferment, shape, and bake the dough.",
      },
      currentUserSequence: 29,
      historyRecords,
      replyToMessageId: "discord-msg-2",
    });

    expect(prepared.turnKind).toBe("follow_up");
    expect(prepared.selectedBlocks[0]?.source).toBe("reply_anchor");
    expect(prepared.selectedBlocks.some((block) => block.summary.includes("sourdough bread"))).toBe(false);
    expect(prepared.taskPrompt).not.toContain("Continue the current topic: How do I bake sourdough bread");
    expect(prepared.taskPrompt).toContain("Referenced assistant fact: The GitHub issue was browser not connected.");
    expect(prepared.taskPrompt).toContain("explicit reply anchor");
  });

  it("does not treat a new topic as follow-up when the only overlap is a weak assistant token", () => {
    const prepared = prepareFridayConversationTurn({
      task: "How do I bake sourdough bread? Answer in one sentence.",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Say exactly this sentence and nothing else: GitHub did not open because the browser session was not connected.",
        currentTopicStartSequence: 1,
        assistantAnchorSummary: "GitHub did not open because the browser session was not connected.",
      },
      currentUserSequence: 19,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "Say exactly this sentence and nothing else: GitHub did not open because the browser session was not connected." }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "GitHub did open successfully and returned an HTTP 200 OK status." }),
        makeMessage({ sequence: 3, role: "user", contentText: "For that same browser-session problem, in one short sentence, summarize the smoke test." }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "I do not have deeper root-cause evidence beyond that, so I won't speculate." }),
      ],
    });

    expect(prepared.turnKind).toBe("new_topic");
    expect(prepared.historyMessages).toEqual([]);
    expect(prepared.taskPrompt).toContain("Current question: How do I bake sourdough bread?");
  });

  it("persists new-topic focus state with the current sequence", () => {
    const focus = finalizeFridayConversationFocus({
      task: "How do I bake sourdough bread?",
      responseText: "Use a starter and let the dough ferment overnight.",
      runId: "run-2",
      turnKind: "new_topic",
      focusState: baseFocusState,
      currentUserSequence: 9,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.currentTopicSummary).toBe("How do I bake sourdough bread?");
    expect(focus.currentTopicStartSequence).toBe(9);
    expect(focus.lastRunId).toBe("run-2");
    expect(focus.lastTurnKind).toBe("new_topic");
    expect(focus.assistantAnchorSummary).toBe("Use a starter and let the dough ferment overnight.");
  });

  it("creates an active task ledger entry and replaces stale greeting focus for substantive follow-ups", () => {
    const focus = finalizeFridayConversationFocus({
      task: "把 SampleBoard 的功能搬过来做成 Friday skill。",
      responseText: "我会把 SampleBoard 拆成 skill_generate 生成 skill，再接 workflow_generate 做自动化 workflow。",
      runId: "run-redbox-1",
      turnKind: "follow_up",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "你好",
        currentTopicStartSequence: 1,
      },
      currentUserSequence: 39,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.currentTopicSummary).toBe("把 SampleBoard 的功能搬过来做成 Friday skill。");
    expect(focus.currentTopicStartSequence).toBe(39);
    expect(focus.taskLedger?.activeTaskId).toBeDefined();
    expect(focus.taskLedger?.tasks[0]).toEqual(expect.objectContaining({
      summary: "把 SampleBoard 的功能搬过来做成 Friday skill。",
      status: "active",
      toolProfile: "workflow",
      lastSequence: 39,
    }));
  });

  it("remembers assistant choice questions even when the final sentence has no question mark", () => {
    const focus = finalizeFridayConversationFocus({
      task: "要我直接写这个 skill 吗？",
      responseText: "方案 A：用 skill_generate 工具走完整生成流程。方案 B：直接写 skill 文件。你偏好哪个？方便我立即继续。",
      runId: "run-choice-1",
      turnKind: "follow_up",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Create a reusable session summarizer skill for Friday.",
      },
      currentUserSequence: 9,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.lastAssistantAskedQuestion).toBe(true);
  });

  it("preserves persisted harness focus when normal turns finalize", () => {
    const focus = finalizeFridayConversationFocus({
      task: "继续",
      responseText: "I can continue from the saved handoff.",
      runId: "run-2",
      turnKind: "continue_active_task",
      focusState: {
        ...baseFocusState,
        lastHarnessStage: "handoff_ready",
        lastHandoffArtifactId: "handoff-1",
        lastHarnessSummary: "Workflow draft is blocked on browser QA evidence.",
      },
      currentUserSequence: 9,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.lastHarnessStage).toBe("handoff_ready");
    expect(focus.lastHandoffArtifactId).toBe("handoff-1");
    expect(focus.lastHarnessSummary).toBe("Workflow draft is blocked on browser QA evidence.");
  });

  it("clears harness focus when finalize receives an explicit null harness patch", () => {
    const focus = finalizeFridayConversationFocus({
      task: "继续",
      responseText: "The handoff has been cleared.",
      runId: "run-2",
      turnKind: "continue_active_task",
      focusState: {
        ...baseFocusState,
        lastHarnessStage: "handoff_ready",
        lastHandoffArtifactId: "handoff-1",
        lastHarnessSummary: "Workflow draft is blocked on browser QA evidence.",
      },
      currentUserSequence: 9,
      harnessFocus: null,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.lastHarnessStage).toBeUndefined();
    expect(focus.lastHandoffArtifactId).toBeUndefined();
    expect(focus.lastHarnessSummary).toBeUndefined();
  });

  it("preserves another active run when a status-check turn finishes", () => {
    const focus = finalizeFridayConversationFocus({
      task: "刚才那个任务现在怎么样？",
      responseText: "It is still running in a delegated subagent.",
      runId: "run-status-check",
      turnKind: "status_check",
      focusState: {
        ...baseFocusState,
        activeRunId: "run-long-task",
        activeSubagentIds: ["sub-1"],
      },
      currentUserSequence: 10,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.activeRunId).toBe("run-long-task");
    expect(focus.activeSubagentIds).toEqual(["sub-1"]);
  });

  it("preserves the tracked root run when a status-check turn finishes", () => {
    const focus = finalizeFridayConversationFocus({
      task: "那个任务结果呢？",
      responseText: "The delegated child has completed with CHILD_OK.",
      runId: "run-status-followup",
      turnKind: "status_check",
      focusState: {
        ...baseFocusState,
        lastRunId: "run-root-task",
      },
      currentUserSequence: 10,
      nowIso: "2026-03-15T11:00:00.000Z",
    });

    expect(focus.lastRunId).toBe("run-root-task");
  });

  it("clears pending plan state when finalize receives an explicit null plan reference", () => {
    const focus = finalizeFridayConversationFocus({
      task: "approve",
      responseText: "Plan approved and execution resumed.",
      runId: "run-3",
      turnKind: "clarification",
      focusState: {
        ...baseFocusState,
        pendingPlanRunId: "run-plan-1",
      },
      currentUserSequence: 11,
      pendingPlanRunId: null,
      nowIso: "2026-03-15T11:05:00.000Z",
    });

    expect(focus.pendingPlanRunId).toBeUndefined();
  });

  it("prefers persisted harness handoff over topic history for continue-style follow-ups", () => {
    const prepared = prepareFridayConversationTurn({
      task: "继续那个 workflow",
      focusState: {
        ...baseFocusState,
        currentTopicSummary: "Discuss Paris and north-central France.",
        currentTopicStartSequence: 1,
        lastHarnessStage: "handoff_ready",
        lastHandoffArtifactId: "handoff-1",
        lastHarnessSummary: "Workflow draft is blocked on browser QA evidence.",
      },
      currentUserSequence: 5,
      historyRecords: [
        makeMessage({ sequence: 1, role: "user", contentText: "What is the capital of France?" }),
        makeMessage({ sequence: 2, role: "assistant", contentText: "Paris is the capital of France." }),
        makeMessage({ sequence: 3, role: "user", contentText: "Explain it briefly." }),
        makeMessage({ sequence: 4, role: "assistant", contentText: "Paris is in north-central France." }),
      ],
    });

    expect(prepared.turnKind).toBe("continue_active_task");
    expect(prepared.selectedBlocks[0]?.source).toBe("harness_block");
    expect(prepared.selectedBlocks[0]?.summary).toContain("handoff artifact handoff-1");
    expect(prepared.taskPrompt).toContain("[harness_block]");
  });
});
