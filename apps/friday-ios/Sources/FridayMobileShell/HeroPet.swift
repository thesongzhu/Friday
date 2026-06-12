import SwiftUI

/// The Retro-LCD Hero Pet (locked: petStyle = retroLcd, petProminence = heroPet).
///
/// A mood companion, NOT a status source of truth: its "here vs offline" face is
/// driven by the projection's honest online/health signal, and the real status is
/// always also shown as text/chips elsewhere on Home. Pure local Canvas drawing —
/// no token, no model call, no image leaves the device.
struct HeroPet: View {
  var online: Bool

  /// A small pixel cat face drawn on a retro-LCD panel.
  private let face: [String] = [
    "X..XX..X",
    ".XXXXXX.",
    "X.XOXO.X",
    "X.XXXX.X",
    "X.X..X.X",
    ".XXXXXX.",
  ]

  var body: some View {
    VStack(spacing: 8) {
      Canvas { ctx, size in
        let cols = 8
        let rows = face.count
        let cell = min(size.width / CGFloat(cols), size.height / CGFloat(rows))
        for (r, line) in face.enumerated() {
          for (c, ch) in Array(line).enumerated() where ch != "." {
            let on = ch == "X"
            let rect = CGRect(
              x: CGFloat(c) * cell + 1, y: CGFloat(r) * cell + 1,
              width: cell - 2, height: cell - 2)
            ctx.fill(
              Path(roundedRect: rect, cornerRadius: 1),
              with: .color(online ? (on ? MobileTheme.lcd : MobileTheme.lcd.opacity(0.35))
                : MobileTheme.lcd.opacity(0.18)))
          }
        }
      }
      .frame(width: 156, height: 118)
      .padding(12)
      .background(MobileTheme.lcdBg, in: RoundedRectangle(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16)
          .strokeBorder(MobileTheme.lcd.opacity(online ? 0.30 : 0.12), lineWidth: 1))

      Text(online ? "Friday is here" : "Friday is offline")
        .font(.subheadline)
        .foregroundStyle(MobileTheme.textSecondary)
    }
  }
}
