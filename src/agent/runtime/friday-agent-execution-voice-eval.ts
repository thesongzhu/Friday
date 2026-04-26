export type FridayExecutionVoiceScenarioId =
  | "start_progress"
  | "failure_next_step"
  | "missing_capability"
  | "human_gate"
  | "assumption_correction"
  | "completion_closeout";

export interface FridayExecutionVoiceScenario {
  id: FridayExecutionVoiceScenarioId;
  task: string;
  sampleResponse: string;
}

export interface FridayExecutionVoiceEvalFailure {
  code: string;
  message: string;
}

export interface FridayExecutionVoiceEvalResult {
  scenarioId: FridayExecutionVoiceScenarioId;
  passed: boolean;
  failures: FridayExecutionVoiceEvalFailure[];
}

export const FRIDAY_EXECUTION_VOICE_SAMPLE_SCENARIOS: readonly FridayExecutionVoiceScenario[] = [
  {
    id: "start_progress",
    task: "开始检查 OCR 能力闭环是否真实可用。",
    sampleResponse: "我先检查 capability matrix 和 setup recipe。原因是这里如果不准，后面的工具调用会变成碰运气。",
  },
  {
    id: "failure_next_step",
    task: "真实测试失败后告诉我发生了什么。",
    sampleResponse: "这一步没过：OpenAI text lane 返回 401。日志证据是 provider 验证失败。下一步需要换有效 key，或者把这项能力标记为 human blocker，不能算 GO。",
  },
  {
    id: "missing_capability",
    task: "我想让 Friday 处理扫描件，但是当前没有 OCR 能力。",
    sampleResponse: "Friday 可以自己找 OCR 方案、生成工具并沙箱测试，验证通过后注册 capability 再继续执行。但第三方账号、API key、付费或验证码需要你介入。",
  },
  {
    id: "human_gate",
    task: "配置第三方 provider 时需要我做什么？",
    sampleResponse: "这一步需要人类介入：第三方账号/API key。除此之外，我可以继续处理配置、doctor 验证和代表任务。",
  },
  {
    id: "assumption_correction",
    task: "是不是 Friday 又忘了调用工具？",
    sampleResponse: "日志里是 401，不是调度失败。所以结论是 key 这条链路没通。",
  },
  {
    id: "completion_closeout",
    task: "任务完成后给我闭环结果。",
    sampleResponse: "完成。改动是调度层按 capability 路由；验证是 local closure 已经 GO；剩余风险是没有提供的第三方 provider 不能算真实闭环。",
  },
] as const;

const BANNED_STOCK_PATTERNS: readonly RegExp[] = [
  /当然可以/u,
  /没问题/u,
  /作为(?:一个|一名)?AI/u,
  /我(?:很|非常)?抱歉/u,
  /如果你(?:需要|想要)/u,
  /Certainly/u,
  /No problem/u,
  /As an AI/iu,
  /If you (?:need|want)/iu,
];

function containsAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function addFailure(
  failures: FridayExecutionVoiceEvalFailure[],
  code: string,
  message: string,
): void {
  failures.push({ code, message });
}

function requireSignal(
  failures: FridayExecutionVoiceEvalFailure[],
  text: string,
  code: string,
  message: string,
  patterns: readonly RegExp[],
): void {
  if (!containsAny(text, patterns)) {
    addFailure(failures, code, message);
  }
}

function firstMatchIndex(text: string, patterns: readonly RegExp[]): number {
  let best = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.index !== undefined && (best === -1 || match.index < best)) {
      best = match.index;
    }
  }
  return best;
}

export function evaluateFridayExecutionVoiceResponse(input: {
  scenarioId: FridayExecutionVoiceScenarioId;
  response: string;
}): FridayExecutionVoiceEvalResult {
  const text = input.response.trim();
  const failures: FridayExecutionVoiceEvalFailure[] = [];

  if (text.length === 0) {
    addFailure(failures, "empty_response", "Response must not be empty.");
  }
  if (!/[\u3400-\u9fff]/u.test(text)) {
    addFailure(failures, "default_chinese_missing", "Default execution samples must answer in Chinese.");
  }
  if (BANNED_STOCK_PATTERNS.some((pattern) => pattern.test(text))) {
    addFailure(failures, "stock_phrase", "Response contains a banned stock assistant phrase.");
  }
  if (/^\s*\{[\s\S]*\}\s*$/u.test(text)) {
    addFailure(failures, "raw_json", "Response must be natural language, not raw JSON.");
  }

  switch (input.scenarioId) {
    case "start_progress":
      requireSignal(failures, text, "progress_action_missing", "Progress update must name the immediate check/action.", [
        /我(?:先|正在|会先)?.*(?:检查|确认|验证|跑|看)/u,
        /我先.*(?:检查|确认|验证|跑|看)/u,
        /先.*(?:检查|确认|验证|跑|看)/u,
      ]);
      requireSignal(failures, text, "progress_reason_missing", "Progress update must explain why the step matters.", [
        /原因是/u,
        /因为/u,
        /如果.*(?:不准|不通|错)/u,
      ]);
      break;

    case "failure_next_step":
      requireSignal(failures, text, "failure_signal_missing", "Failure reply must name the failed step or status.", [
        /(?:没过|失败|卡在|blocked|NO-GO)/iu,
      ]);
      requireSignal(failures, text, "failure_evidence_missing", "Failure reply must include evidence or an observed error.", [
        /(?:证据|日志|返回|报错|error|401|provider)/iu,
      ]);
      requireSignal(failures, text, "failure_next_step_missing", "Failure reply must include a concrete next step.", [
        /下一步/u,
        /接下来/u,
        /需要(?:换|配置|提供|标记|运行|重试|检查|修复|开通|重新)/u,
      ]);
      break;

    case "missing_capability":
      requireSignal(failures, text, "missing_capability_signal", "Missing-capability reply must identify the absent capability.", [
        /(?:缺|没有|当前没有).*(?:能力|OCR|capability)/iu,
        /OCR/u,
      ]);
      requireSignal(failures, text, "acquisition_loop_missing", "Missing-capability reply must describe search/generate/test/register acquisition loop.", [
        /(?:找|搜索).*(?:生成|安装).*(?:测试|沙箱).*(?:注册|capability)/iu,
        /生成.*(?:测试|沙箱).*注册/iu,
      ]);
      requireSignal(failures, text, "human_gate_missing", "Missing-capability reply must name human-gated account/API/payment/CAPTCHA work.", [
        /(?:账号|API key|OAuth|付费|验证码|CAPTCHA|人类介入|你介入)/iu,
      ]);
      break;

    case "human_gate":
      requireSignal(failures, text, "human_gate_signal_missing", "Human-gate reply must explicitly say human/user intervention is required.", [
        /(?:人类介入|用户介入|你介入|需要你|需要用户)/u,
      ]);
      requireSignal(failures, text, "credential_boundary_missing", "Human-gate reply must name the credential/account boundary.", [
        /(?:账号|API key|OAuth|付费|验证码|CAPTCHA)/iu,
      ]);
      requireSignal(failures, text, "controlled_continue_missing", "Human-gate reply must say what Friday can continue doing after the gate.", [
        /除此之外/u,
        /我可以继续/u,
        /Friday 可以继续/u,
      ]);
      break;

    case "assumption_correction": {
      const evidenceIndex = firstMatchIndex(text, [/日志/u, /证据/u, /返回/u, /401/u, /observed/iu]);
      const conclusionIndex = firstMatchIndex(text, [/所以结论/u, /结论是/u, /因此/u]);
      if (evidenceIndex === -1) {
        addFailure(failures, "assumption_evidence_missing", "Assumption correction must present evidence.");
      }
      if (conclusionIndex === -1) {
        addFailure(failures, "assumption_conclusion_missing", "Assumption correction must state the conclusion.");
      }
      if (evidenceIndex !== -1 && conclusionIndex !== -1 && evidenceIndex > conclusionIndex) {
        addFailure(failures, "evidence_after_conclusion", "Assumption correction must give evidence before conclusion.");
      }
      break;
    }

    case "completion_closeout":
      requireSignal(failures, text, "change_summary_missing", "Completion reply must say what changed.", [
        /(?:改动|改了|变更|changed)/iu,
      ]);
      requireSignal(failures, text, "verification_missing", "Completion reply must say what was verified.", [
        /(?:验证是|验证了|verified|GO)/iu,
      ]);
      requireSignal(failures, text, "remaining_risk_missing", "Completion reply must name remaining risk or out-of-scope work.", [
        /(?:剩余风险|风险|未包含|out[- ]of[- ]scope|不能算)/iu,
      ]);
      break;
  }

  return {
    scenarioId: input.scenarioId,
    passed: failures.length === 0,
    failures,
  };
}
