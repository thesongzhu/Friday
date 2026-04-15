export async function execute(input, ctx) {
  const { transcript } = input;
  if (!transcript) {
    throw new Error('Transcript is required.');
  }

  const actionItems = extractActionItems(transcript);
  return { actionItems };
}

function extractActionItems(transcript) {
  const actionItems = [];
  const lines = transcript.split('\n');

  for (const line of lines) {
    const match = line.match(/\[(.*?)\] (.*?)(?: by (.*?))?(?: due (.*?))?/);
    if (match) {
      const [, owner, action, , deadline] = match;
      actionItems.push({ owner: owner.trim(), action: action.trim(), deadline: deadline ? deadline.trim() : null });
    }
  }

  return actionItems;
}