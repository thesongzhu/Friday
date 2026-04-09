export async function execute(input) {
  const serviceNotes = typeof input.serviceNotes === "string" ? input.serviceNotes.trim() : "";
  if (!serviceNotes) {
    throw new Error("Service notes are required.");
  }
  return {
    serviceBrief: [
      "客服与售后简报 / Customer Service Brief",
      "- Group refund, return, and review issues by root cause.",
      "- Suggest the best reply posture and when to escalate.",
      "- Separate product-quality issues from logistics and expectation mismatch.",
      "",
      `Source Notes:\n${serviceNotes}`,
    ].join("\n"),
  };
}

