import type {
  FridayContextEngine,
  FridayContextEngineAfterTurnInput,
  FridayContextEngineResolveInput,
  FridayContextEngineResolveResult,
} from "./friday-agent-runtime.types.js";
import { loadFridayWorkspaceContext } from "./friday-agent-workspace-context.js";

export function createFridayWorkspaceContextEngine(input: {
  workspaceDir: string;
}): FridayContextEngine {
  return {
    async assemble(params) {
      const workspaceContext = await loadFridayWorkspaceContext(input.workspaceDir, {
        task: params.task,
        selectedBlocks: params.conversationContext?.selectedBlocks,
      });
      return {
        workspaceContext,
        promptFragment: workspaceContext.promptFragment,
      };
    },
  };
}

export async function resolveFridayContextEnginePromptFragment(
  engine: FridayContextEngine | undefined,
  input: FridayContextEngineResolveInput,
): Promise<FridayContextEngineResolveResult> {
  if (!engine) {
    return {};
  }

  await Promise.resolve(engine.ingest?.(input));
  const assembled = await Promise.resolve(engine.assemble?.(input)) ?? {};
  const compacted = await Promise.resolve(engine.compact?.({
    ...input,
    assembled,
  })) ?? assembled;

  return {
    workspaceContext: compacted.workspaceContext ?? assembled.workspaceContext,
    promptFragment: compacted.promptFragment ?? assembled.promptFragment,
  };
}

export async function notifyFridayContextEngineAfterTurn(
  engine: FridayContextEngine | undefined,
  input: FridayContextEngineAfterTurnInput,
): Promise<void> {
  try {
    await Promise.resolve(engine?.afterTurn?.(input));
  } catch (err) {
    // Preview hook failures must never fail an agent run.
    console.warn("[friday][agent-context-engine] afterTurn hook failed:", err instanceof Error ? err.message : String(err));
  }
}
