/**
 * Builds a deterministic agent task string to run a skill via the agent runtime.
 * The agent interprets this as a skill invocation instruction.
 */
export function buildSkillRunTask(
  skillId: string,
  inputs: Record<string, unknown>,
): string {
  const inputLines: string[] = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") {
      inputLines.push(`  ${key}: ${JSON.stringify(value)}`);
    } else {
      inputLines.push(`  ${key}: ${String(value)}`);
    }
  }

  const inputBlock =
    inputLines.length > 0
      ? `\nInputs:\n${inputLines.join("\n")}`
      : "";

  return `Run skill "${skillId}"${inputBlock}`;
}
