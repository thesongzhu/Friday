import type {
  FridayGuideLensOverlayMode,
  FridayGuideLensScreenshotIntakeRequest,
  FridayGuideLensScreenshotIntakeResult,
} from "../model/friday-guide-lens.types.js";
import { redactGuideLensText } from "./redaction.js";

function classifyIntent(text: string, question: string | undefined): {
  intent: FridayGuideLensScreenshotIntakeResult["intent"];
  confidence: number;
  mode: FridayGuideLensOverlayMode;
  summary: string;
} {
  const combined = `${question ?? ""}\n${text}`.toLowerCase();
  if (/(sk-|api key|access token|secret|password|passcode|验证码|密码|密钥)/i.test(combined)) {
    return {
      intent: "sensitive",
      confidence: 0.82,
      mode: "confirm_step",
      summary: "截图里可能包含敏感字段，我会先遮挡内容，再只引导你该看哪里。",
    };
  }
  if (/(accessibility|screen recording|privacy|security|permission|权限|辅助功能|屏幕录制)/i.test(combined)) {
    return {
      intent: "permission",
      confidence: 0.78,
      mode: "focus_frame",
      summary: "这看起来是权限或系统设置页面，需要你本人确认授权。",
    };
  }
  if (/(error|failed|exception|denied|not found|无法|失败|报错|错误)/i.test(combined)) {
    return {
      intent: "error",
      confidence: 0.76,
      mode: "speech_bubble",
      summary: "截图显示有错误或失败状态，我会先定位错误文案，再引导下一步。",
    };
  }
  if (/(sign in|login|log in|oauth|authorize|email|password|登录|授权|邮箱)/i.test(combined)) {
    return {
      intent: "form",
      confidence: 0.72,
      mode: "focus_frame",
      summary: "这像是表单、登录或授权流程，真实输入和确认都需要你来完成。",
    };
  }
  if (/(scroll|below|next page|new tab|new window|continue|往下|下滑|新网页|新页面|下一页)/i.test(combined)) {
    return {
      intent: "navigation",
      confidence: 0.7,
      mode: "scroll_hint",
      summary: "这一步可能需要打开新页面或滚动；我会持续重新观察并提示你方向。",
    };
  }
  if (/(setup|install|configure|connect|设置|安装|配置|连接)/i.test(combined)) {
    return {
      intent: "setup",
      confidence: 0.66,
      mode: "speech_bubble",
      summary: "截图像是在设置或连接流程中，我会按步骤引导你完成。",
    };
  }
  if ((question?.trim().length ?? 0) > 0 || /[?？]/.test(combined)) {
    return {
      intent: "question",
      confidence: 0.62,
      mode: "speech_bubble",
      summary: "用户在围绕截图提问，我会先回答可确定的部分。",
    };
  }
  return {
    intent: "unknown",
    confidence: 0.38,
    mode: "speech_bubble",
    summary: "截图意图还不够明确，需要一句补充说明才能给出准确引导。",
  };
}

function shouldAskChatbox(input: {
  intent: FridayGuideLensScreenshotIntakeResult["intent"];
  confidence: number;
  text: string;
  question?: string;
}): boolean {
  if (input.question?.trim()) return false;
  if (input.intent === "unknown") return true;
  if (input.confidence < 0.55) return true;
  return input.text.trim().length < 12;
}

export function analyzeFridayGuideLensScreenshot(
  input: FridayGuideLensScreenshotIntakeRequest & { sessionId: string },
): FridayGuideLensScreenshotIntakeResult {
  const rawText = [input.visibleText, input.screenshotText]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
  const redacted = redactGuideLensText(rawText, "screenshot_text");
  const classified = classifyIntent(redacted.text, input.question);
  const needsChatbox = shouldAskChatbox({
    intent: classified.intent,
    confidence: classified.confidence,
    text: redacted.text,
    question: input.question,
  });

  return {
    sessionId: input.sessionId,
    intent: classified.intent,
    summary: classified.summary,
    needsChatbox,
    chatboxPrompt: needsChatbox
      ? "我看到了截图，但还不确定你的目标。你想让我引导你完成哪一步？"
      : undefined,
    suggestedGuideMode: classified.mode,
    redactedText: redacted.text,
    redactions: redacted.redactions,
    confidence: classified.confidence,
  };
}
