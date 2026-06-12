import SwiftUI

/// Design tokens for the Hub Console, derived from the LOCKED desktop baseline
/// (friday-design-handoff-20260602/saved/desktop-selection.json):
///   background = warmOffWhite, form = glassNative, palette = cyanCoral,
///   theme = light, density = comfort, visualAlignment = lightAlignment.
///
/// This is a "light alignment" — palette + form tokens only, not a full redesign.
public enum HubTheme {
  // MARK: Palette (cyan action + coral urgency/accent — locked baseline)

  /// Warm off-white app background (calm, flat, no gradient).
  static let backgroundWarmOffWhite = Color(red: 0.98, green: 0.97, blue: 0.95)
  /// Slightly deeper warm tone for the nav rail.
  static let navRailBackground = Color(red: 0.96, green: 0.95, blue: 0.92)
  /// Glass-native panel fill (translucent native-feeling).
  static let glassPanel = Color.white.opacity(0.72)
  static let glassPanelBorder = Color.black.opacity(0.06)

  /// Cyan = action / selection.
  static let cyan = Color(red: 0.07, green: 0.55, blue: 0.62)
  static let cyanSoft = Color(red: 0.07, green: 0.55, blue: 0.62).opacity(0.12)
  /// Coral = urgency / needs-me / accent (and the subtleStatus pet accent).
  static let coral = Color(red: 0.93, green: 0.42, blue: 0.38)
  static let coralSoft = Color(red: 0.93, green: 0.42, blue: 0.38).opacity(0.14)

  static let textPrimary = Color(red: 0.13, green: 0.13, blue: 0.14)
  static let textSecondary = Color(red: 0.40, green: 0.40, blue: 0.42)
  static let textMono = Color(red: 0.30, green: 0.34, blue: 0.40)

  // MARK: Form

  static let cornerRadius: CGFloat = 12
  static let panelPadding: CGFloat = 16
  static let rowSpacing: CGFloat = 10  // comfort density

  // MARK: Status chip colors (honest truth rendering)
  //
  // These map truth/lifecycle to a calm-but-honest chip color. Critically, a
  // not-done / linked-only / stale / blocked state NEVER renders in the "ready"
  // green — the UI must not upgrade truth_status.

  static let chipNeutralBG = Color.black.opacity(0.06)
  static let chipNeutralFG = textSecondary
  static let chipDoneBG = Color(red: 0.20, green: 0.55, blue: 0.40).opacity(0.16)
  static let chipDoneFG = Color(red: 0.13, green: 0.42, blue: 0.30)
  static let chipWarnBG = coralSoft
  static let chipWarnFG = Color(red: 0.74, green: 0.27, blue: 0.24)
  static let chipPendingBG = cyanSoft
  static let chipPendingFG = cyan
}

/// A glass-native panel container (locked form).
struct GlassPanel<Content: View>: View {
  let content: Content
  init(@ViewBuilder content: () -> Content) { self.content = content() }

  var body: some View {
    content
      .padding(HubTheme.panelPadding)
      .background(
        RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
          .fill(HubTheme.glassPanel)
          .overlay(
            RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
              .strokeBorder(HubTheme.glassPanelBorder, lineWidth: 1)
          )
      )
  }
}
