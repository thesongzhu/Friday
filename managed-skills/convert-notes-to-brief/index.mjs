import { runtimeContext } from 'friday-runtime-context';

export async function execute(input, ctx) {
  try {
    const { notes } = input;
    if (!notes) {
      throw new Error('Notes input is required.');
    }

    const aiResponse = await runtimeContext.callAIService({
      prompt: `Convert the following notes into a follow-up brief for a Chinese B2B sales rep. Include deal stage, blockers, recommended next message, and next follow-up date. Notes: ${notes}`,
      language: 'zh',
    });

    return { followUpBrief: aiResponse.text };
  } catch (error) {
    console.error('Error executing skill:', error);
    throw error;
  }
}
