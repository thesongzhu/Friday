import FridayHubConsoleCore
import SwiftUI

/// The right-docked proof inspector (locked: proofInspector = rightDocked).
///
/// Shows the redacted refs for the currently selected row — refs only, no body
/// load. Also hosts the subtleStatus pet accent (desktopPet = subtleStatus):
/// a small status dot tinted by feed health, an accent only.
struct ProofInspector: View {
  let state: WorkbenchLoadState
  let selection: InspectorSelection
  let refs: [InspectorRef]

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 8) {
        PetStatusAccent(state: state)
        Text("Proof Inspector")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Spacer()
      }

      Text("Refs only · bodies never inlined")
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)

      Divider().opacity(0.4)

      if case .none = selection {
        VStack(alignment: .leading, spacing: 6) {
          Text("Nothing selected")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(HubTheme.textSecondary)
          Text("Select a work item, capability, route, or transcript event to inspect its evidence refs.")
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
        }
      } else if refs.isEmpty {
        Text("No refs for this selection.")
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
      } else {
        Text(selectionTitle)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(refs) { ref in
              RefPill(label: ref.label, ref: ref.ref)
            }
          }
        }
      }

      Spacer()

      // Honest read-only reminder — the inspector navigates evidence, it cannot act.
      Text("Read-only evidence view. No dispatch or provider action from here.")
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .padding(HubTheme.panelPadding)
    .background(HubTheme.glassPanel)
  }

  private var selectionTitle: String {
    switch selection {
    case .none: return ""
    case .workItem: return "Work item evidence"
    case .capability: return "Capability evidence"
    case .transcriptEvent: return "Transcript event evidence"
    case .routeDecision: return "Route decision evidence"
    }
  }
}

/// The subtleStatus desktop pet: a tiny status dot used as an accent only.
/// Coral when the feed is unavailable/pending, cyan when live, grey while loading.
struct PetStatusAccent: View {
  let state: WorkbenchLoadState

  private var color: Color {
    switch state {
    case .loaded(let snapshot):
      if snapshot.runtimeFeedStatus.isHealthy && snapshot.statusLabels.isEmpty {
        return HubTheme.cyan
      }
      return HubTheme.coral
    case .unavailable:
      return HubTheme.coral
    case .loading, .idle:
      return HubTheme.textSecondary.opacity(0.5)
    }
  }

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 9, height: 9)
      .overlay(Circle().strokeBorder(Color.white.opacity(0.6), lineWidth: 1))
      .help("Friday status accent")
  }
}
