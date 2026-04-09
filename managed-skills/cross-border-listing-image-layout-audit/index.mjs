export async function execute(input) {
  const listingNotes = typeof input.listingNotes === "string" ? input.listingNotes.trim() : "";
  if (!listingNotes) {
    throw new Error("Listing notes are required.");
  }
  return {
    listingAudit: [
      "图片与详情页审核 / Listing Image Layout Audit",
      "- Review hero image clarity and first-glance benefit communication.",
      "- Check detail-page pacing, information hierarchy, and localization fit.",
      "- Suggest which image or layout element should be replaced first.",
      "",
      `Source Notes:\n${listingNotes}`,
    ].join("\n"),
  };
}

