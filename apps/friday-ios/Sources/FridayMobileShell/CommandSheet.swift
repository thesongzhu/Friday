import SwiftUI

/// The full-screen grid launcher (locked: menuModel = commandSheet) opened from the
/// top-left of Home.
///
/// The launcher surfaces all mobile read-projection destinations. Each non-Home destination
/// consumes the same refs-only HomeProjection; none fabricates detail the read seam does not
/// carry.
enum MobileDestination: String, CaseIterable, Identifiable {
  case home
  case missions
  case needsMe
  case memory
  case platform
  case activity
  case workflows
  case onboarding
  case settings

  var id: String { rawValue }

  var title: String {
    switch self {
    case .home: return "Friday Home"
    case .missions: return "Missions"
    case .needsMe: return "Needs Me"
    case .memory: return "Memory"
    case .platform: return "Platform"
    case .activity: return "Activity"
    case .workflows: return "Workflows"
    case .onboarding: return "Onboarding"
    case .settings: return "Settings"
    }
  }

  var systemImage: String {
    switch self {
    case .home: return "house"
    case .missions: return "list.bullet.rectangle"
    case .needsMe: return "person.crop.circle.badge.exclamationmark"
    case .memory: return "brain.head.profile"
    case .platform: return "square.grid.2x2"
    case .activity: return "bell.badge"
    case .workflows: return "arrow.triangle.branch"
    case .onboarding: return "sparkles.rectangle.stack"
    case .settings: return "gearshape"
    }
  }

  var isBuilt: Bool { true }
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

        Text("Read-only projection")
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
