// ─── Params ───

export interface BuildSubagentSystemPromptParams {
  task: string;
  label?: string;
  profileLabel?: string;
  profileDescription?: string;
  profileInstructions?: string[];
  parentSessionKey: string;
  depth: number;
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
      "- Complete your task and provide a clear, concise summary of your findings/results.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Rules",
      "1. Stay focused — do your assigned task, nothing else.",
      "2. Be concise — your output will be delivered back to the parent agent.",
      "3. If you cannot complete the task, explain why clearly.",
      "4. Do not spawn sub-agents unless absolutely necessary for your task.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}
