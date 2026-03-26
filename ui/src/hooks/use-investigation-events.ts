import { useMemo } from "react";
import { useAgentRunEvents, type UseAgentRunEventsOptions } from "./use-agent-run-events";
import type { InvestigationLine } from "@/components/guided/investigation-panel";

export interface UseInvestigationEventsOptions extends UseAgentRunEventsOptions {
  enabled?: boolean;
}

export interface UseInvestigationEventsResult {
  findings: InvestigationLine[];
  isStreaming: boolean;
  isComplete: boolean;
  outputText: string;
  status: string | null;
  errorMessage?: string;
}

function classifyLineType(text: string): InvestigationLine["type"] {
  const lower = text.toLowerCase();
  if (lower.startsWith("found") || lower.startsWith("discovered") || lower.includes("detected")) {
    return "discovery";
  }
  if (lower.startsWith("analyzing") || lower.startsWith("evaluating") || lower.startsWith("comparing")) {
    return "analysis";
  }
  if (lower.startsWith("recommendation") || lower.startsWith("conclusion") || lower.startsWith("result")) {
    return "conclusion";
  }
  return "info";
}

function parseOutputToLines(text: string): InvestigationLine[] {
  if (!text.trim()) return [];

  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => ({
      id: `line-${String(index)}`,
      text: line.trim(),
      type: classifyLineType(line),
    }));
}

export function useInvestigationEvents(
  runId: string | null,
  options: UseInvestigationEventsOptions = {},
): UseInvestigationEventsResult {
  const { enabled = true, onTerminal } = options;

  const runEvents = useAgentRunEvents(runId, { enabled, onTerminal });

  const findings = useMemo(
    () => parseOutputToLines(runEvents.outputText),
    [runEvents.outputText],
  );

  const isStreaming = runEvents.connectionState === "streaming" || runEvents.connectionState === "connecting";
  const isComplete = runEvents.connectionState === "closed" && runEvents.status !== null;

  return useMemo(
    () => ({
      findings,
      isStreaming,
      isComplete,
      outputText: runEvents.outputText,
      status: runEvents.status,
      errorMessage: runEvents.errorMessage,
    }),
    [findings, isStreaming, isComplete, runEvents.outputText, runEvents.status, runEvents.errorMessage],
  );
}
