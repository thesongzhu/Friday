import { runtimeContext } from 'friday-runtime-context';

export async function execute(input, ctx) {
    try {
        const { marketNotes, watchlistUpdates } = input;

        if (!marketNotes || !watchlistUpdates) {
            throw new Error('Both marketNotes and watchlistUpdates are required.');
        }

        const aiResponse = await runtimeContext.callAIService({
            prompt: `Transform the following market notes and watchlist updates into a neutral research digest with catalysts, risks, and a review checklist in Chinese.\n\nMarket Notes: ${marketNotes}\n\nWatchlist Updates: ${watchlistUpdates}`,
            language: 'zh'
        });

        return { researchDigest: aiResponse.result };
    } catch (error) {
        console.error('Error executing skill:', error);
        throw error;
    }
}