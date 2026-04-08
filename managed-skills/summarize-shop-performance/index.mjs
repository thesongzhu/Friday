import { runtimeContext } from 'friday-runtime';

export async function execute(input, ctx) {
  try {
    const { performanceNotes } = input;
    if (!performanceNotes) {
      throw new Error('Performance notes are required.');
    }

    const aiResponse = await ctx.ai.complete({
      prompt: `Summarize the following shop performance notes into issue clusters for ads, inventory, order health, and recommended actions in Chinese: ${performanceNotes}`,
      maxTokens: 500
    });

    return { issueClusters: aiResponse.text };
  } catch (error) {
    return { error: error.message };
  }
}