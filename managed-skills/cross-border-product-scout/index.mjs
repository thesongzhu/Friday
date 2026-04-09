export async function execute(input) {
  const marketSignals = typeof input.marketSignals === "string" ? input.marketSignals.trim() : "";
  if (!marketSignals) {
    throw new Error("Market signals input is required.");
  }
  return {
    productScout: [
      "机会点 / Opportunities",
      "- Identify categories with repeated demand signals and workable price bands.",
      "风险点 / Risks",
      "- Avoid shallow hype, fragile margins, and products that depend on weak fulfillment or support.",
      "继续验证的问题 / Next Questions",
      "- What is the repeatability of demand, and what proof is still missing before launch?",
      "",
      `原始输入 / Source Notes:\n${marketSignals}`,
    ].join("\n"),
  };
}

