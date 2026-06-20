import SwiftUI

/// The full-screen grid launcher (locked: menuModel = commandSheet) opened from the
/// top-left of Home.
///
/// Only Home is built in M-PR1. The other destinations exist in the LOCKED mobile
/// design (Platform/Provider workspace, Activity, Workflows, Settings) and appear
/// as honest "not in this PR" placeholders — never faked content.
enum MobileDestination: String, CaseIterable, Identifiable {
  case home
  case platform
  case activity
  case workflows
  case settings

  var id: String { rawValue }

  var title: String {
    switch self {
    case .home: return "Friday Home"
    case .platform: return "Platform"
    case .activity: return "Activity"
    case .workflows: return "Workflows"
    case .settings: return "Settings"
    }
  }

  var systemImage: String {
    switch self {
    case .home: return "house"
    case .platform: return "square.grid.2x2"
    case .activity: return "bell.badge"
    case .workflows: return "arrow.triangle.branch"
    case .settings: return "gearshape"
    }
  }

  /// Whether this destination is implemented in M-PR1.
  var isBuilt: Bool { self == .home }
}

/// The Command Sheet: a full-screen 2-column grid launcher.
struct CommandSheet: View {
  @Binding var destination: MobileDestination
  @Binding var isOpen: Bool

  private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: columns, spacing: 14) {
          ForEach(MobileDestination.allCases) { dest in
            Button {
              if dest.isBuilt { destination = dest }
              isOpen = false
            } label: {
              tile(dest)
            }
            .buttonStyle(.plain)
            .disabled(!dest.isBuilt)
          }
        }
        .padding(16)

        Text("Read-only mode · more surfaces coming online")
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .padding(.top, 8)
      }
      .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
      .navigationTitle("Friday")
      .navigationBarTitleDisplayMode(.large)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { isOpen = false }.tint(MobileTheme.cyan)
        }
      }
    }
  }

  private func tile(_ dest: MobileDestination) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Image(systemName: dest.systemImage)
          .font(.system(size: 26))
          .foregroundStyle(dest.isBuilt ? MobileTheme.cyan : MobileTheme.textSecondary)
        Spacer()
        if dest == destination {
          StatusChip(text: "open", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
        } else if !dest.isBuilt {
          StatusChip(text: "soon", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
        }
      }
      Text(dest.title)
        .font(.headline)
        .foregroundStyle(dest.isBuilt ? MobileTheme.textPrimary : MobileTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
    .padding(16)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .strokeBorder(MobileTheme.glassPanelBorder, lineWidth: 1))
  }
}
