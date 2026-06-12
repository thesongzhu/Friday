import Foundation
import FridayRustClient

// MARK: - Wire → display adapter
//
// The `FridayRustClient` package returns a THIN refs-only wire snapshot
// (`FridayRustClient.WorkbenchSnapshot`: missionId / runtimeFeedStatus(String) /
// statusLabels([String]) / routeDecisionSummary / workItemIds([String]) / generatedAtMs /
// `raw`). The Console UI consumes the RICH, fully-typed `WorkbenchSnapshot` (work-items with
// state/owner/done, capability states, transcript sections, receipt arrays, memory
// candidates, the typed route decision). The thin model cannot feed the UI, so we bridge.
//
// The bridge is the wire snapshot's `raw` field — the FULL decoded refs-only projection JSON
// the package kept precisely "so a UI can read fields this typed view does not surface". We
// re-serialize `raw` and Codable-decode it into the rich display model. The rich model's
// camelCase contract is wire-identical to the Rust projection JSON the package decoded, so
// this is a clean re-decode, not a lossy mapping.
//
// TRUTH RULE: a serialize/decode failure must surface as honest UNAVAILABLE (the caller maps
// the throw to `.unavailable`). We never make rich fields optional to force a partial decode —
// that would fabricate a ready-looking snapshot from an unparseable projection.

public enum WorkbenchSnapshotAdapter {
  /// Adapt the package's refs-only wire snapshot into the Console's rich display snapshot by
  /// re-decoding its retained `raw` projection JSON.
  ///
  /// Throws `FridayRustReadClientError.projectionUnavailable` on a serialize/decode failure —
  /// which the view model renders AS truth ("unavailable"), never as a fabricated snapshot.
  public static func display(
    from wire: FridayRustClient.WorkbenchSnapshot
  ) throws -> WorkbenchSnapshot {
    let data: Data
    do {
      data = try JSONSerialization.data(withJSONObject: wire.raw)
    } catch {
      throw FridayRustReadClientError.projectionUnavailable(
        reason: "projection JSON could not be re-serialized: \(error)")
    }
    do {
      return try JSONDecoder().decode(WorkbenchSnapshot.self, from: data)
    } catch {
      throw FridayRustReadClientError.projectionUnavailable(
        reason: "projection JSON did not match the Workbench contract: \(error)")
    }
  }
}
