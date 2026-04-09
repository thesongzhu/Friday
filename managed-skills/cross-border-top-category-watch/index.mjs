export async function execute(input) {
  const categoryWatchNotes = typeof input.categoryWatchNotes === "string" ? input.categoryWatchNotes.trim() : "";
  if (!categoryWatchNotes) {
    throw new Error("Category watch notes are required.");
  }
  return {
    watchBoard: [
      "Top 10 类目监控 / Top Category Watch",
      "- Summarize movement across the leading sellers and products.",
      "- Note pricing, positioning, hero-image, and message changes.",
      "- Flag anything worth following tomorrow.",
      "",
      `Source Notes:\n${categoryWatchNotes}`,
    ].join("\n"),
  };
}

