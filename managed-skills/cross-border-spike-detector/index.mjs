export async function execute(input) {
  const spikeSignals = typeof input.spikeSignals === "string" ? input.spikeSignals.trim() : "";
  if (!spikeSignals) {
    throw new Error("Spike signals are required.");
  }
  return {
    spikeReview: [
      "爆发商品判断 / Spike Detector",
      "- Highlight sudden attention or rank movement.",
      "- Separate durable demand from short promo spikes.",
      "- List what still needs manual validation before following.",
      "",
      `Source Notes:\n${spikeSignals}`,
    ].join("\n"),
  };
}

