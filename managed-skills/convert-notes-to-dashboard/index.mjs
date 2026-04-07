export async function execute(input, ctx) {
  try {
    const notes = input.notes;
    if (!notes) {
      throw new Error('Notes input is required.');
    }

    // Simulate processing notes into a dashboard
    const dashboard = `Dashboard:
- Cashflow reminders: ...
- People issues: ...
- Vendor/admin follow-ups: ...
- Next-step delegation bullets: ... (in Chinese)`;

    return { dashboard };
  } catch (error) {
    return { error: error.message };
  }
}
