export async function execute(input) {
  const priceSignals = typeof input.priceSignals === "string" ? input.priceSignals.trim() : "";
  if (!priceSignals) {
    throw new Error("Price signals are required.");
  }
  return {
    priceReview: [
      "价格带与跟价判断 / Price Match Review",
      "- Compare your price, coupon stack, shipping promise, and bundles.",
      "- Explain when following price is justified and when it is not.",
      "- Call out listing or fulfillment gaps that should be fixed before price moves.",
      "",
      `Source Notes:\n${priceSignals}`,
    ].join("\n"),
  };
}

