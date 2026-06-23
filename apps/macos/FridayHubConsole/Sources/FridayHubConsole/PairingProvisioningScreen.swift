import AppKit
import CoreImage.CIFilterBuiltins
import FridayHubConsoleCore
import SwiftUI
import UniformTypeIdentifiers

struct PairingProvisioningScreen: View {
  @StateObject private var viewModel = PairingProvisioningViewModel()
  @State private var inputPayload = ""
  @State private var showImporter = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header
        inputPanel
        qrPanel
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .background(HubTheme.backgroundWarmOffWhite)
    .fileImporter(
      isPresented: $showImporter,
      allowedContentTypes: [.json, .plainText],
      allowsMultipleSelection: false,
      onCompletion: importManifest)
  }

  private var header: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          Image(systemName: "qrcode.viewfinder")
            .font(.system(size: 24, weight: .semibold))
            .foregroundStyle(HubTheme.cyan)
          VStack(alignment: .leading, spacing: 3) {
            Text("Pairing Provisioning")
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(HubTheme.textPrimary)
            Text("short-lived scan material")
              .font(.system(size: 11))
              .foregroundStyle(HubTheme.textSecondary)
          }
          Spacer()
          statusChip(viewModel.state.mode.rawValue)
        }
        Text(viewModel.state.reason)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
    }
  }

  private var inputPanel: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 12) {
        Text("Hub QR Manifest")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        TextEditor(text: $inputPayload)
          .font(.system(size: 12, design: .monospaced))
          .frame(minHeight: 120)
          .scrollContentBackground(.hidden)
          .background(Color.white.opacity(0.62), in: RoundedRectangle(cornerRadius: 8))
          .accessibilityIdentifier("friday.desktop.pairing-qr-json-input")
        HStack(spacing: 8) {
          Button {
            Task { await viewModel.startPairingSession() }
          } label: {
            Label("Start Session", systemImage: "antenna.radiowaves.left.and.right")
          }
          .buttonStyle(.borderedProminent)
          .disabled(!viewModel.canStartPairingSession)

          Button {
            viewModel.load(qrJSON: inputPayload)
          } label: {
            Label("Decode", systemImage: "checkmark.shield")
          }
          .buttonStyle(.bordered)
          .disabled(inputPayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

          Button {
            showImporter = true
          } label: {
            Label("Import", systemImage: "tray.and.arrow.down")
          }
          .buttonStyle(.bordered)

          Button {
            inputPayload = ""
            viewModel.clear()
          } label: {
            Image(systemName: "xmark.circle")
          }
          .buttonStyle(.bordered)
          .accessibilityLabel("Clear pairing manifest")
        }
      }
    }
  }

  private var qrPanel: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Scan")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(HubTheme.textPrimary)
          Spacer()
          Button {
            copyPayload()
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
          }
          .buttonStyle(.bordered)
          .disabled(!viewModel.canRenderQRCode)
        }
        if let projection = viewModel.state.projection, viewModel.canRenderQRCode {
          HStack(alignment: .top, spacing: 16) {
            if let image = QRCodeRenderer.image(for: viewModel.qrPayload) {
              Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(width: 220, height: 220)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("Friday pairing QR code")
            }
            VStack(alignment: .leading, spacing: 8) {
              RefPill(label: "hub_id", ref: projection.hubId)
              RefPill(label: "pairing_id", ref: projection.pairingId)
              RefPill(label: "expires_at", ref: String(projection.expiresAt))
              if let manifestPath = viewModel.state.manifestPath, !manifestPath.isEmpty {
                RefPill(label: "manifest", ref: manifestPath)
              }
              ForEach(projection.transportLabels, id: \.self) { label in
                statusChip(label)
              }
              Text("Scan material stays local to this screen; display rows are redacted.")
                .font(.system(size: 11))
                .foregroundStyle(HubTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        } else {
          Text("No trusted QR manifest loaded.")
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
        }
      }
    }
  }

  private func importManifest(_ result: Result<[URL], Error>) {
    do {
      guard let url = try result.get().first else { return }
      let scoped = url.startAccessingSecurityScopedResource()
      defer {
        if scoped { url.stopAccessingSecurityScopedResource() }
      }
      let data = try Data(contentsOf: url)
      let payload = String(decoding: data, as: UTF8.self)
      inputPayload = payload
      viewModel.load(data: data)
    } catch {
      inputPayload = ""
      viewModel.clear()
    }
  }

  private func copyPayload() {
    guard viewModel.canRenderQRCode else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(viewModel.qrPayload, forType: .string)
  }

  private func statusChip(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(HubTheme.textSecondary)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Capsule().fill(Color.black.opacity(0.06)))
  }
}

private enum QRCodeRenderer {
  static func image(for payload: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(payload.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let image = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
    let rep = NSCIImageRep(ciImage: image)
    let nsImage = NSImage(size: rep.size)
    nsImage.addRepresentation(rep)
    return nsImage
  }
}

#Preview("Pairing Provisioning") {
  PairingProvisioningScreen()
    .frame(width: 860, height: 680)
}
