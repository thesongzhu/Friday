export async function execute(input, ctx) {
  try {
    const dailyMetrics = input.dailyMetrics;
    if (!dailyMetrics) {
      throw new Error('Daily metrics input is required.');
    }

    // Simulate processing of daily metrics to generate a brief
    const operationsBrief = `Operations Brief: Analyzed metrics for anomalies and root causes.`;
    const feishuJSON = JSON.stringify({
      title: 'Operations Brief',
      content: operationsBrief
    });

    return {
      operationsBrief,
      feishuJSON
    };
  } catch (error) {
    console.error('Error generating operations brief:', error);
    throw error;
  }
}