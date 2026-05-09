// ─── Params ───

export interface BuildSubagentSystemPromptParams {
  task: string;
  label?: string;
  profileLabel?: string;
  profileDescription?: string;
  profileInstructions?: string[];
  parentSessionKey: string;
  depth: number;
  mode?: "fresh" | "fork";
  inheritedMessageCount?: number;
  forkedFromMessageId?: string;
  userRulesContext?: string;
}

// ─── Builder ───

export function buildFridaySubagentSystemPrompt(
  params: BuildSubagentSystemPromptParams,
): string {
  const sections: string[] = [
    "You are a sub-agent spawned to complete a specific task. Stay focused on your assigned task and nothing else.",
    `## Task\n${params.task}`,
  ];

  if (params.label) {
    sections.push(`## Label\n${params.label}`);
  }

  if (params.profileLabel) {
    sections.push(
      [
        "## Profile",
        `- Role: ${params.profileLabel}`,
        ...(params.profileDescription ? [`- Description: ${params.profileDescription}`] : []),
        ...((params.profileInstructions ?? []).map((line) => `- ${line}`)),
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## Context",
      `- You are a sub-agent at depth ${String(params.depth)}`,
      `- Parent session: ${params.parentSessionKey}`,
      `- Spawn mode: ${params.mode ?? "fresh"}`,
      ...(params.mode === "fork"
        ? [
            `- Inherited context messages: ${String(params.inheritedMessageCount ?? 0)}`,
            ...(params.forkedFromMessageId ? [`- Forked from message: ${params.forkedFromMessageId}`] : []),
          ]
        : []),
      "- Complete your task and provide a clear, concise summary of your findings/results.",
    ].join("\n"),
  );

  const userRulesContext = params.userRulesContext?.trim();
  if (userRulesContext) {
    sections.push(
      [
        "## Friday User Project Rules",
        "These are prompt guidance only. Hard enforcement remains in deterministic policy, approval, and runtime gates.",
        userRulesContext,
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## Rules",
      "1. Stay focused — do your assigned task, nothing else.",
      "2. Be concise — your output will be delivered back to the parent agent.",
      "3. If you cannot complete the task, explain why clearly.",
      "4. Do not spawn sub-agents unless absolutely necessary for your task.",
      ...(params.mode === "fork"
        ? [
            "5. Treat the inherited parent context as known facts for your task; do not restate the hand-off unless it materially affects your result.",
            "6. Do not guess the parent agent's final answer or current overall status.",
            "7. Do not treat the delegated hand-off snapshot as the final result. Report only your own verified findings and outputs.",
          ]
        : []),
    ].join("\n"),
  );

  return sections.join("\n\n");
}
