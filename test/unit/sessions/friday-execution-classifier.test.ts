import { describe, it, expect } from "vitest";
import {
  classifyFridayExecution,
} from "../../../src/sessions/services/friday-execution-classifier.js";
import type { FridaySessionConversationFocusState } from "../../../src/sessions/model/friday-session.types.js";

function makeFocus(overrides?: Partial<FridaySessionConversationFocusState>): FridaySessionConversationFocusState {
  return { updatedAt: "2026-01-01T00:00:00Z", ...overrides };
}

describe("classifyFridayExecution", () => {
  describe("status checks", () => {
    it("classifies status_check turn as sync_immediate/task_status", () => {
      const result = classifyFridayExecution({
        task: "What's the status?",
        turnKind: "status_check",
        focusState: makeFocus(),
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("task_status");
    });

    it("does not classify status_check when pending plan exists", () => {
      const result = classifyFridayExecution({
        task: "What's the status?",
        turnKind: "status_check",
        focusState: makeFocus({ pendingPlanRunId: "plan-123" }),
      });
      // Should not hit task_status because pending plan; will fall through
      // to capability check or agent path
      expect(result.category).not.toBe("sync_immediate");
    });
  });

  describe("capability queries", () => {
    it("classifies 'what can you do' as capabilities", () => {
      const result = classifyFridayExecution({
        task: "What can you do?",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("capabilities");
    });

    it("classifies 'capabilities' as capabilities", () => {
      const result = classifyFridayExecution({
        task: "Show me the capabilities",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("capabilities");
    });

    it("classifies Chinese capability query", () => {
      const result = classifyFridayExecution({
        task: "能做什么",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("capabilities");
    });

    it("classifies channel authority questions as capabilities instead of setup", () => {
      const result = classifyFridayExecution({
        task: "飞书和其他渠道可以控制100%的 Friday 所有能力对吧？",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("capabilities");
    });

    it("classifies 'is mcp enabled' as capabilities", () => {
      const result = classifyFridayExecution({
        task: "Is MCP enabled?",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("capabilities");
    });

    it("does not treat blocked-or-disabled tool instructions as capability queries", () => {
      const result = classifyFridayExecution({
        task: 'Use the skill_run tool on skillId "system-health-snapshot" with input {}. Do not summarize the system manually. If the tool is blocked or disabled, report the exact blocker and stop.',
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("does not treat plain deployment facts as capability queries", () => {
      const result = classifyFridayExecution({
        task: "Turn 3 fact: the deployment region is us-west-2.",
        turnKind: "follow_up",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });
  });

  describe("approval commands", () => {
    it("classifies 'approve' without pending plan as approval_decision", () => {
      const result = classifyFridayExecution({
        task: "approve",
        turnKind: "new_topic",
        focusState: makeFocus(),
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("approval_decision");
      expect(result.extractedParams).toEqual({
        decision: "approve",
      });
    });

    it("defers 'approve' with pending plan to agent (planning gate)", () => {
      const result = classifyFridayExecution({
        task: "approve",
        turnKind: "new_topic",
        focusState: makeFocus({ pendingPlanRunId: "plan-456" }),
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("classifies explicit approval id for direct control", () => {
      const result = classifyFridayExecution({
        task: "reject approval-123",
        turnKind: "new_topic",
        focusState: makeFocus(),
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("approval_decision");
      expect(result.extractedParams).toEqual({
        approvalId: "approval-123",
        decision: "reject",
      });
    });

    it("classifies 'reject' without pending plan as approval_decision", () => {
      const result = classifyFridayExecution({
        task: "reject",
        turnKind: "new_topic",
        focusState: makeFocus(),
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("approval_decision");
      expect(result.extractedParams).toEqual({
        decision: "reject",
      });
    });
  });

  describe("daemon status", () => {
    it("classifies 'daemon status' as daemon_status", () => {
      const result = classifyFridayExecution({
        task: "daemon status",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("daemon_status");
    });

    it("classifies 'is friday running' as daemon_status", () => {
      const result = classifyFridayExecution({
        task: "Is Friday running?",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("daemon_status");
    });
  });

  describe("MCP queries", () => {
    it("classifies 'list mcp servers' as mcp_list", () => {
      const result = classifyFridayExecution({
        task: "List MCP servers",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("mcp_list");
    });

    it("classifies 'list available mcp servers' as mcp_list", () => {
      const result = classifyFridayExecution({
        task: "List available MCP servers",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("mcp_list");
    });

    it("classifies 'query mcp server info' as mcp_list", () => {
      const result = classifyFridayExecution({
        task: "Query MCP server info",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("mcp_list");
    });

    it("does not treat a plain MCP fact as an MCP list query", () => {
      const result = classifyFridayExecution({
        task: "Turn 8 fact: the MCP server nickname is oak-bridge.",
        turnKind: "follow_up",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });
  });

  describe("workflow queries", () => {
    it("classifies 'workflow status' as workflow_query", () => {
      const result = classifyFridayExecution({
        task: "Show me the workflow status",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("workflow_query");
    });

    it("extracts a workflow run id for specific workflow status queries", () => {
      const result = classifyFridayExecution({
        task: "workflow status wf-run-42",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("workflow_query");
      expect(result.extractedParams).toEqual({
        runId: "wf-run-42",
      });
    });
  });

  describe("setup guidance", () => {
    it("classifies explicit Discord binding requests as setup guidance", () => {
      const result = classifyFridayExecution({
        task: "需要绑定discord",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "discord" });
    });

    it("classifies setup info requests as setup guidance", () => {
      const result = classifyFridayExecution({
        task: "告诉我流程，我需要提供什么可以绑定discord",
        turnKind: "follow_up",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "discord" });
    });

    it("classifies explicit Feishu setup requests as setup guidance", () => {
      const result = classifyFridayExecution({
        task: "如何配置飞书渠道接入 Friday？",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "feishu" });
    });

    it("does not mistake Feishu capability consultation for setup guidance", () => {
      const result = classifyFridayExecution({
        task: "在飞书里回复用户：Friday 能不能帮我把公司内部一个混乱项目审计清楚、列出问题、排优先级、必要时生成报告和自动化？我不知道从哪里开始。",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("does not mistake Feishu task requests for channel setup", () => {
      const result = classifyFridayExecution({
        task: "帮我把飞书里的项目消息整理成风险报告",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("does not treat start-work wording in a Feishu task as channel setup", () => {
      const result = classifyFridayExecution({
        task: "开始审计飞书里的项目消息，先列出风险和优先级",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("does not treat English add-work wording with Feishu as channel setup", () => {
      const result = classifyFridayExecution({
        task: "Add the Feishu project audit notes to the report and prioritize the risks.",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("uses the current focus to resolve short direct-operation follow-ups", () => {
      const result = classifyFridayExecution({
        task: "你直接去操作",
        turnKind: "follow_up",
        focusState: makeFocus({
          currentTopicSummary: "User wants to bind Discord as a Friday channel.",
          assistantAnchorSummary: "Discord is not registered yet.",
        }),
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "discord" });
    });

    it("uses setup focus for terse next-step follow-ups without requiring the service name again", () => {
      const result = classifyFridayExecution({
        task: "下一步",
        turnKind: "follow_up",
        focusState: makeFocus({
          currentTopicSummary: "User is configuring Feishu as a Friday channel.",
          assistantAnchorSummary: "Feishu setup requires app credentials and verification.",
        }),
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "feishu" });
    });

    it("classifies OCR setup requests as capability setup guidance", () => {
      const result = classifyFridayExecution({
        task: "帮我配置OCR",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "ocr" });
    });

    it("classifies vision setup requests as capability setup guidance", () => {
      const result = classifyFridayExecution({
        task: "我想开启看图功能",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "vision" });
    });

    it("classifies custom capability setup requests as setup guidance", () => {
      const result = classifyFridayExecution({
        task: "配置自定义能力",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "custom" });
    });

    it("does not treat ordinary prose containing 'line' as LINE setup guidance", () => {
      const result = classifyFridayExecution({
        task: "Create a cron workflow that writes a line 'tick' to the log every minute.",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("still classifies explicit LINE setup requests", () => {
      const result = classifyFridayExecution({
        task: "Connect LINE channel",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("setup_guidance");
      expect(result.extractedParams).toEqual({ setupTargetService: "line" });
    });
  });

  describe("session recall and policy boundaries", () => {
    it("classifies last-message recall as deterministic session recall", () => {
      const result = classifyFridayExecution({
        task: "你还记得我上次最后写的是什么吗？",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("last_user_message");
    });

    it("classifies anti-detection scraping skill requests as a deterministic boundary", () => {
      const result = classifyFridayExecution({
        task: "你可以自己写一个skills去爬小红书的内容吗？不被发现和不被ban的。",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("unsafe_automation_boundary");
    });

    it("Phase 14.5B module_28b: classifies imperative 'repair' as deterministic repair preview", () => {
      const result = classifyFridayExecution({
        task: "repair",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("repair_preview");
    });

    it("Phase 14.5B module_28b: classifies 'repair friday' as deterministic repair preview", () => {
      const result = classifyFridayExecution({
        task: "repair friday",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("repair_preview");
    });

    it("Phase 14.5B module_28b: classifies Chinese 修复 as deterministic repair preview", () => {
      const result = classifyFridayExecution({
        task: "修复",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("sync_immediate");
      expect(result.handler).toBe("repair_preview");
    });
  });

  describe("workflow control commands", () => {
    it("classifies cancel with run id as managed_async workflow control", () => {
      const result = classifyFridayExecution({
        task: "cancel wf-run-42",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("managed_async");
      expect(result.handler).toBe("workflow_control");
      expect(result.extractedParams).toEqual({
        controlAction: "cancel",
        runId: "wf-run-42",
      });
    });

    it("classifies retry without run id as managed_async clarification path", () => {
      const result = classifyFridayExecution({
        task: "retry",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("managed_async");
      expect(result.handler).toBe("workflow_control");
      expect(result.extractedParams).toEqual({
        controlAction: "retry",
      });
    });
  });

  describe("agent fallback", () => {
    it("classifies free-text question as agent_exception_path", () => {
      const result = classifyFridayExecution({
        task: "Help me write a function to sort numbers",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("classifies follow_up turn as agent_exception_path", () => {
      const result = classifyFridayExecution({
        task: "Can you elaborate on that?",
        turnKind: "follow_up",
        focusState: makeFocus(),
      });
      expect(result.category).toBe("agent_exception_path");
    });

    it("classifies complex request as agent_exception_path", () => {
      const result = classifyFridayExecution({
        task: "Create a new workflow that sends daily Slack summaries",
        turnKind: "new_topic",
        focusState: null,
      });
      expect(result.category).toBe("agent_exception_path");
    });
  });
});
