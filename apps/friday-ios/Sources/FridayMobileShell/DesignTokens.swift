import SwiftUI

/// Design tokens for the Friday Mobile shell, derived from the LOCKED mobile
/// baseline (friday-design-handoff-20260602/saved/mobile-selection.json):
///   variant = claudeCalm, palette = cyanCoral, theme = light,
///   background = warmOffWhite, form = glassNative, motion = richRestrained,
///   petStyle = retroLcd, density = comfort.
///
/// Tokens are intentionally aligned with the desktop sibling's `HubTheme`
/// (#676) so both consume the same locked palette/form vocabulary.
enum MobileTheme {
  // MARK: Palette (cyan action + coral urgency/accent — locked baseline)

  /// Warm off-white app background (calm, flat, no gradient).
  static let backgroundWarmOffWhite = Color(red: 0.98, green: 0.97, blue: 0.95)
  /// Glass-native panel fill (translucent native-feeling).
  static let glassPanelBorder = Color.black.opacity(0.06)

  /// Cyan = action / selection.
  static let cyan = Color(red: 0.07, green: 0.55, blue: 0.62)
  static let cyanSoft = Color(red: 0.07, green: 0.55, blue: 0.62).opacity(0.12)
  /// Coral = urgency / needs-me / accent.
  static let coral = Color(red: 0.93, green: 0.42, blue: 0.38)
  static let coralSoft = Color(red: 0.93, green: 0.42, blue: 0.38).opacity(0.14)

  static let textPrimary = Color(red: 0.13, green: 0.13, blue: 0.14)
  static let textSecondary = Color(red: 0.40, green: 0.40, blue: 0.42)
  static let textMono = Color(red: 0.30, green: 0.34, blue: 0.40)

  /// The 155px Hero Pet stage card background (locked: `#eef3e8`, from the mobile gallery's
  /// `.hero.pet-stage-card`). The pet itself is the v9 `pet-stage-engine.js` companion rendered
  /// over a transparent WKWebView (see `MobilePetView`), so this is just the card behind it.
  static let petStageBg = Color(red: 0.933, green: 0.953, blue: 0.910)  // #eef3e8

  // MARK: Form (glass native)

  static let cornerRadius: CGFloat = 16
  static let panelPadding: CGFloat = 16
  static let rowSpacing: CGFloat = 10  // comfort density

  // MARK: Status chip colors (honest truth rendering)
  //
  // A not-done / linked-only / stale / blocked state NEVER renders in the "ready"
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
      .padding(MobileTheme.panelPadding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
          .strokeBorder(MobileTheme.glassPanelBorder, lineWidth: 1)
      )
  }
}

enum FridayButtonVariant {
  case primary
  case secondary
  case quiet
}

struct FridayButtonStyle: ButtonStyle {
  let variant: FridayButtonVariant

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .frame(minHeight: 40)
      .foregroundStyle(foreground)
      .background(background(for: configuration.isPressed), in: Capsule())
      .overlay(Capsule().strokeBorder(border, lineWidth: 1))
      .scaleEffect(configuration.isPressed ? 0.985 : 1)
  }

  private var foreground: Color {
    switch variant {
    case .primary: return .white
    case .secondary: return MobileTheme.cyan
    case .quiet: return MobileTheme.textSecondary
    }
  }

  private var border: Color {
    switch variant {
    case .primary: return MobileTheme.cyan.opacity(0.10)
    case .secondary: return MobileTheme.cyan.opacity(0.24)
    case .quiet: return MobileTheme.glassPanelBorder
    }
  }

  private func background(for pressed: Bool) -> Color {
    let opacity = pressed ? 0.82 : 1.0
    switch variant {
    case .primary: return MobileTheme.cyan.opacity(opacity)
    case .secondary: return MobileTheme.cyanSoft.opacity(pressed ? 0.72 : 1)
    case .quiet: return Color.white.opacity(pressed ? 0.38 : 0.54)
    }
  }
}

struct FridayButton<Label: View>: View {
  let variant: FridayButtonVariant
  let action: () -> Void
  let label: Label

  init(variant: FridayButtonVariant = .primary, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
    self.variant = variant
    self.action = action
    self.label = label()
  }

  var body: some View {
    Button(action: action) {
      label
    }
    .buttonStyle(FridayButtonStyle(variant: variant))
  }
}

/// A selected-design status chip. Color renders truth HONESTLY and is never upgraded.
struct FridayChip: View {
  let text: String
  let bg: Color
  let fg: Color

  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .medium))
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .background(Capsule().fill(bg))
      .overlay(Capsule().strokeBorder(Color.white.opacity(0.45), lineWidth: 0.5))
      .foregroundStyle(fg)
      .accessibilityLabel(text)
  }
}

struct FridayFilter: View {
  let label: String
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.system(size: 12, weight: .semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .foregroundStyle(selected ? .white : MobileTheme.cyan)
        .background(selected ? MobileTheme.cyan : MobileTheme.cyanSoft, in: Capsule())
        .overlay(Capsule().strokeBorder(MobileTheme.cyan.opacity(0.20), lineWidth: 1))
    }
    .buttonStyle(.plain)
  }
}

struct FridaySegmentedControl: View {
  let options: [String]
  @Binding var selection: String

  var body: some View {
    HStack(spacing: 4) {
      ForEach(options, id: \.self) { option in
        FridayFilter(label: option, selected: option == selection) {
          selection = option
        }
      }
    }
    .padding(4)
    .background(.ultraThinMaterial, in: Capsule())
    .overlay(Capsule().strokeBorder(MobileTheme.glassPanelBorder, lineWidth: 1))
  }
}

/// A monospaced redacted-ref proof line. Refs only — there is no expand/load affordance.
struct FridayProofLine: View {
  let label: String?
  let ref: String

  var body: some View {
    HStack(spacing: 6) {
      if let label {
        Text(label)
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(MobileTheme.textSecondary)
      }
      Text(ref)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(MobileTheme.textMono)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
        .truncationMode(.middle)
    }
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(Color.white.opacity(0.52))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(MobileTheme.glassPanelBorder, lineWidth: 1)
    )
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityText)
  }

  private var accessibilityText: String {
    if let label {
      return "\(label): \(ref)"
    }
    return ref
  }
}
