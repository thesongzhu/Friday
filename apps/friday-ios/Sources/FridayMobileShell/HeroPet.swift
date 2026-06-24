import SwiftUI

/// The Friday Home Hero Pet — the locked 155px animated v9 mobile companion (petStyle =
/// retroLcd, petProminence = heroPet), rendered as the PURE-DOG hero card from the locked mobile
/// design (`mobile-gallery.html` `heroBlock()` / `.hero.pet-stage-card`).
///
/// This is the bare pet STAGE: NO text, NO status badges inside the card (the gallery's home pet
/// stage is a bare `#eef3e8` card with only the dog). The honest read-seam status truth lives in
/// the Status card below — the pet is a mood companion, NOT a status source of truth (mirroring
/// the desktop `CompanionPetView`, which takes no `online` param). The animation runs the EXISTING
/// `pet-stage-engine.js` against the bundled v9 assets via `MobilePetView` (WKWebView). Pure local
/// CSS-JS-canvas — no token, no model call, no image leaves the device.
struct HeroPet: View {
  let height: CGFloat

  init(height: CGFloat = 155) {
    self.height = height
  }

  var body: some View {
    ZStack {
      // The 155px pure-dog hero card (locked: #eef3e8 stage bg, 16pt corner).
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .fill(MobileTheme.petStageBg)
      #if canImport(WebKit)
      MobilePetView()
      #else
      // macOS host build (no WebKit-backed pet): honest placeholder, never a fake pet.
      Text("Friday companion (WebKit unavailable on host build)")
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 16)
      #endif
    }
    .frame(height: height)
    .clipShape(RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .strokeBorder(MobileTheme.glassPanelBorder, lineWidth: 1))
    .accessibilityLabel("Friday dog companion")
  }
}
