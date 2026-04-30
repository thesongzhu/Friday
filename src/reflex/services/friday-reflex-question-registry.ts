import type { FridayReflexQuestion } from "../model/friday-reflex.types.js";

export const FRIDAY_REFLEX_ONBOARDING_QUESTIONS: readonly FridayReflexQuestion[] = [
  {
    id: "O1",
    title: "默认语言",
    scenario: "Friday 第一次和你协作，还不知道你希望它用哪种语言。",
    prompt: "你希望 Friday 默认怎么选择回答语言？",
    options: [
      { value: "follow_input", label: "跟随我输入", description: "你用中文就中文，你用英文就英文。" },
      { value: "zh", label: "默认中文", description: "除非你明确要求英文，否则默认中文。" },
      { value: "en", label: "默认英文", description: "除非你明确要求中文，否则默认英文。" },
    ],
    skippable: true,
  },
  {
    id: "O2",
    title: "称呼",
    scenario: "Friday 可以记住一个你喜欢的称呼，并在所有绑定渠道里一致使用。",
    prompt: "你希望 Friday 怎么称呼你？",
    options: [
      { value: "custom", label: "我输入一个称呼", description: "保存为明确偏好，跨渠道生效。" },
      { value: "none", label: "暂时不固定称呼", description: "Friday 不会主动给你设定称呼。" },
    ],
    skippable: true,
  },
  {
    id: "O3",
    title: "回答长度",
    scenario: "同一个问题，Friday 可以只给结论，也可以展开原因和步骤。",
    prompt: "你希望 Friday 默认回答多长？",
    options: [
      { value: "concise", label: "直接给结论", description: "适合高频操作和快速决策。" },
      { value: "balanced", label: "结论加关键原因", description: "默认信息量适中。" },
      { value: "detailed", label: "尽量详细", description: "适合复杂计划、研究和排错。" },
    ],
    skippable: true,
  },
  {
    id: "O4",
    title: "输出组织方式",
    scenario: "Friday 输出方案、对比、执行结果时，需要选择你更容易扫读的结构。",
    prompt: "你希望 Friday 默认怎么组织内容？",
    options: [
      { value: "compact", label: "少量段落", description: "保持自然，不把简单事写复杂。" },
      { value: "balanced", label: "清单式", description: "段落和要点混合。" },
      { value: "structured", label: "表格和步骤优先", description: "适合计划、对比和审查。" },
    ],
    skippable: true,
  },
  {
    id: "O5",
    title: "不确定时怎么做",
    scenario: "Friday 有时能安全推断，有时继续猜会造成返工或风险。",
    prompt: "当 Friday 不确定你的意图时，你希望它怎么做？",
    options: [
      { value: "ask_first", label: "先问清楚", description: "减少猜测，速度会慢一点。" },
      { value: "balanced", label: "小问题自己推断，大问题再问", description: "默认平衡效率和准确性。" },
      { value: "infer_first", label: "先给方案再标注假设", description: "适合你想快速推进时。" },
    ],
    skippable: true,
  },
  {
    id: "O6",
    title: "明确记忆",
    scenario: "你明确说“记住这个”“以后都这样”时，Friday 可以把它变成长期偏好。",
    prompt: "这类明确指令应该怎么处理？",
    options: [
      { value: "save_immediately", label: "直接记住", description: "立即成为明确偏好，Review Center 可撤销。" },
      { value: "confirm_first", label: "先给我确认", description: "Friday 会在写入长期记忆前确认。" },
      { value: "session_only", label: "只在当前会话记住", description: "不写入长期记忆。" },
    ],
    skippable: true,
  },
  {
    id: "O7",
    title: "推测偏好",
    scenario: "Friday 可能从重复行为里看出偏好，但你没有明说。",
    prompt: "这种推测应该怎么处理？",
    options: [
      { value: "review_candidate", label: "放到待审核", description: "不直接覆盖你的明确设置。" },
      { value: "do_not_record", label: "不记录", description: "只按当前任务处理。" },
      { value: "project_only", label: "只在本项目临时使用", description: "不成为全局偏好。" },
    ],
    skippable: true,
  },
  {
    id: "O8",
    title: "重复任务",
    scenario: "如果你反复让 Friday 做同类任务，它可以沉淀成可复用方法。",
    prompt: "发现重复任务时，Friday 应该怎么做？",
    options: [
      { value: "notify_only", label: "只提醒我", description: "Friday 只提示可以自动化。" },
      { value: "recipe_candidate", label: "生成可审核 recipe", description: "整理步骤，但不直接变成工具。" },
      { value: "automation_draft", label: "生成 skill/workflow 草稿", description: "会测试草稿，但批准前不启用。" },
    ],
    skippable: true,
  },
  {
    id: "O9",
    title: "已有 skill",
    scenario: "Friday 发现已有能力包可能能完成当前任务。",
    prompt: "它应该怎么处理？",
    options: [
      { value: "prefer_existing", label: "先用现有 skill", description: "优先复用已安装能力。" },
      { value: "explain_then_ask", label: "先解释再问我", description: "适合你想知道为什么要用 skill。" },
      { value: "explicit_only", label: "只在我明确要求时用", description: "默认少自动化。" },
    ],
    skippable: true,
  },
  {
    id: "O10",
    title: "生成 skill",
    scenario: "当前没有合适 skill，但 Friday 可以创建一个新能力包。",
    prompt: "Friday 应该怎么做？",
    options: [
      { value: "draft_for_approval", label: "生成草稿等我批准", description: "批准前不启用。" },
      { value: "suggest_only", label: "只建议，不生成", description: "由你决定是否开始。" },
      { value: "ask_details_first", label: "先问更多细节", description: "减少无效草稿。" },
    ],
    skippable: true,
  },
  {
    id: "O11",
    title: "生成 workflow",
    scenario: "有些任务更适合变成多步骤 workflow，而不是一次性聊天。",
    prompt: "这种情况 Friday 应该怎么做？",
    options: [
      { value: "draft_workflow", label: "生成 workflow 草稿", description: "批准前不部署。" },
      { value: "plan_only", label: "只生成计划", description: "不进入 workflow 生成器。" },
      { value: "do_not_suggest", label: "不主动建议 workflow", description: "只按一次性任务处理。" },
    ],
    skippable: true,
  },
  {
    id: "O12",
    title: "冷启动扫描",
    scenario: "第一次使用时，Friday 可以扫描本机上下文，让第一天就更懂你的项目。",
    prompt: "Friday 可以扫描哪些内容？",
    options: [
      { value: "workspace", label: "当前 workspace", description: "只看当前项目。" },
      { value: "workspace_friday", label: "workspace + Friday 历史", description: "包含已有 Friday 记忆和导出。" },
      { value: "workspace_imports", label: "workspace + 本地旧技能", description: "可发现 OpenClaw、Hermes、Codex、Cursor 等技能。" },
    ],
    skippable: true,
  },
  {
    id: "O13",
    title: "旧技能导入",
    scenario: "Friday 扫描到其他工具或旧 Friday 的技能时，可以迁移成 Friday 能力。",
    prompt: "它应该怎么处理？",
    options: [
      { value: "list_only", label: "只列出来", description: "不转换。" },
      { value: "convert_draft", label: "转成 Friday 草稿等我确认", description: "批准前不安装。" },
      { value: "batch_review", label: "批量导入前显示风险", description: "适合迁移很多技能。" },
    ],
    skippable: true,
  },
  {
    id: "O14",
    title: "代码任务测试深度",
    scenario: "Friday 改代码后，需要决定默认测试范围。",
    prompt: "代码任务默认测试到什么程度？",
    options: [
      { value: "related", label: "只跑相关测试", description: "速度最快。" },
      { value: "related_integration", label: "相关 + 集成", description: "更稳一些。" },
      { value: "deep_live", label: "加随机/对抗/Live LLM", description: "最容易发现问题，成本更高。" },
    ],
    skippable: true,
  },
  {
    id: "O15",
    title: "未知场景测试",
    scenario: "有些功能不知道真实用户会怎么输入，固定用例不够。",
    prompt: "Friday 应该怎么测未知和不稳定场景？",
    options: [
      { value: "fixed_random", label: "固定用例 + 随机输入", description: "覆盖正常和随机边界。" },
      { value: "adversarial", label: "随机输入 + 故意破坏边界", description: "主动找问题。" },
      { value: "live_environment", label: "加真实模型/真实环境验证", description: "最接近真实使用。" },
    ],
    skippable: true,
  },
  {
    id: "O16",
    title: "出错后怎么处理",
    scenario: "Friday 运行失败时，可以只记录，也可以尝试低风险自修。",
    prompt: "出错时你希望 Friday 怎么做？",
    options: [
      { value: "diagnose_then_ask", label: "先诊断再问我", description: "默认保守。" },
      { value: "auto_low_risk", label: "自动尝试低风险修复", description: "不碰高风险改动。" },
      { value: "record_only", label: "只记录问题，不修", description: "由你决定后续。" },
    ],
    skippable: true,
  },
  {
    id: "O17",
    title: "高风险改动边界",
    scenario: "有些修复会改文件、配置、token 或数据。",
    prompt: "这类动作 Friday 应该怎么处理？",
    options: [
      { value: "always_approve", label: "必须先审批", description: "最安全。" },
      { value: "risk_based", label: "低风险可改，高风险审批", description: "平衡效率和安全。" },
      { value: "plan_only", label: "永远只给计划", description: "不自动执行真实改动。" },
    ],
    skippable: true,
  },
  {
    id: "O18",
    title: "候选提醒位置",
    scenario: "Friday 学到的候选记忆、recipe、skill、workflow 需要给你看。",
    prompt: "你希望在哪里看到？",
    options: [
      { value: "review_and_chat", label: "Review Center + 对话提醒", description: "集中管理，也能在聊天里确认。" },
      { value: "review_center", label: "只在 Review Center", description: "减少对话打扰。" },
      { value: "chat_only", label: "只在对话里", description: "不用单独打开页面。" },
    ],
    skippable: true,
  },
  {
    id: "O19",
    title: "成功步骤沉淀",
    scenario: "Friday 成功完成任务后，可以把步骤总结成下次可复用的方法。",
    prompt: "它可以自动总结吗？",
    options: [
      { value: "candidate", label: "可以，进入待审核", description: "你批准后再长期使用。" },
      { value: "after_positive_feedback", label: "只在我点赞后总结", description: "更少候选。" },
      { value: "disabled", label: "不自动总结", description: "不从成功任务里生成 recipe。" },
    ],
    skippable: true,
  },
  {
    id: "O20",
    title: "记忆冲突",
    scenario: "旧记忆、新推测、你刚说的话有时会冲突。",
    prompt: "Friday 应该相信谁？",
    options: [
      { value: "latest_explicit", label: "你刚说的话优先", description: "最新明确指令覆盖旧偏好。" },
      { value: "stored_explicit_warn", label: "明确记忆优先但提醒冲突", description: "更保守。" },
      { value: "ask_each_time", label: "每次问我", description: "避免误改。" },
    ],
    skippable: true,
  },
  {
    id: "O21",
    title: "主动搜索记忆",
    scenario: "当问题涉及过去、偏好、之前决定时，Friday 可以先搜记忆再回答。",
    prompt: "你希望它怎么做？",
    options: [
      { value: "required_for_past", label: "涉及过去/偏好时必须搜", description: "更一致。" },
      { value: "only_when_asked", label: "只在我说“记得吗”时搜", description: "减少检索。" },
      { value: "never_proactive", label: "不主动搜", description: "只看当前对话。" },
    ],
    skippable: true,
  },
  {
    id: "O22",
    title: "学习透明度",
    scenario: "Friday 可以告诉你它刚学到了什么，也可以只在集中页面里显示。",
    prompt: "你希望怎么展示“Friday 学到了什么”？",
    options: [
      { value: "brief_each_time", label: "每次简短提示", description: "透明但会多一点提示。" },
      { value: "review_center_only", label: "只在 Review Center", description: "对话更清爽。" },
      { value: "digest", label: "每日/每周总结", description: "适合批量查看。" },
    ],
    skippable: true,
  },
  {
    id: "O23",
    title: "自动化保守程度",
    scenario: "Friday 可以很保守，也可以更积极地产生可撤销候选。",
    prompt: "你希望自动化倾向如何？",
    options: [
      { value: "conservative", label: "非常保守", description: "少生成候选，多问你。" },
      { value: "balanced", label: "平衡", description: "只在明显有价值时生成。" },
      { value: "proactive", label: "积极但可撤销", description: "更多候选，但不绕过审批。" },
    ],
    skippable: true,
  },
  {
    id: "O24",
    title: "真实模型自测",
    scenario: "某些能力需要真实 LLM 才能验证，但会消耗 quota 且可能不稳定。",
    prompt: "Friday 可以使用真实模型做自测吗？",
    options: [
      { value: "allowed_with_cost_notice", label: "可以，标记成本和不稳定", description: "用于 release/live 验证。" },
      { value: "manual_only", label: "只在我手动触发", description: "默认不自动消耗额度。" },
      { value: "disabled", label: "不允许", description: "只跑 mock/deterministic 测试。" },
    ],
    skippable: true,
  },
];

export const FRIDAY_REFLEX_ONBOARDING_QUESTION_IDS = FRIDAY_REFLEX_ONBOARDING_QUESTIONS.map((q) => q.id);

export function getFridayReflexQuestion(questionId: string): FridayReflexQuestion | null {
  return FRIDAY_REFLEX_ONBOARDING_QUESTIONS.find((question) => question.id === questionId) ?? null;
}

export function getNextFridayReflexQuestionId(answeredOrSkipped: ReadonlySet<string>): string | null {
  for (const question of FRIDAY_REFLEX_ONBOARDING_QUESTIONS) {
    if (!answeredOrSkipped.has(question.id)) {
      return question.id;
    }
  }
  return null;
}
