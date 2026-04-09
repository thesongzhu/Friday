export async function execute(input) {
  const weeklySignals = typeof input.weeklySignals === "string" ? input.weeklySignals.trim() : "";
  if (!weeklySignals) {
    throw new Error("Weekly signals are required.");
  }
  return {
    weeklyReview: [
      "每周增长复盘 / Weekly Growth Review",
      "- Summarize what changed across ads, category watch, price band, listing quality, and support.",
      "- Decide what to keep, change, or stop next week.",
      "- Highlight workflow adjustments before the next cycle starts.",
      "",
      `Source Notes:\n${weeklySignals}`,
    ].join("\n"),
  };
}

