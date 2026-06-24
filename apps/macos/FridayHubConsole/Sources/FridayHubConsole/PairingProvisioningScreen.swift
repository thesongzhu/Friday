import AppKit
import CoreImage.CIFilterBuiltins
import FridayHubConsoleCore
import SwiftUI
import UniformTypeIdentifiers

struct PairingProvisioningScreen: View {
  @StateObject private var viewModel = PairingProvisioningViewModel()
  @State private var inputPayload = ""
  @State private var showImporter = false
  private let operatorCommand = PairingProvisioningViewModel.operatorProvisioningCommand()

  var body: some View {
    ScrollView {
      renderProofContent
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

  var renderProofContent: some View {
    VStack(alignment: .leading, spacing: 16) {
      header
      inputPanel
      pathwayPanel
      qrPanel
      operatorPanel
    }
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
            Label("Start Local", systemImage: "desktopcomputer")
          }
          .buttonStyle(.borderedProminent)
          .disabled(!viewModel.canStartPairingSession)

          Button {
            Task { await viewModel.startPairingSession(exposureMode: .privateLan) }
          } label: {
            Label("Start LAN QR", systemImage: "wifi")
          }
          .buttonStyle(.bordered)
          .disabled(!viewModel.canStartPairingSession)
          .help("Start a private-LAN QR pairing server for a real phone on this network.")

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

  private var pathwayPanel: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Provisioning Path")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(HubTheme.textPrimary)
          Spacer()
          statusChip("no app mint")
        }
        Text("PairAck, trust grant, and context passport remain separate governed steps. This panel shows the path; readiness still comes from the Hub DB projection.")
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        ForEach(viewModel.provisioningSteps) { step in
          provisioningStepRow(step)
        }
      }
    }
    .accessibilityIdentifier("friday.desktop.pairing-provisioning-path")
  }

  private func provisioningStepRow(_ step: PairingProvisioningStep) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: step.satisfied ? "checkmark.circle.fill" : "circle")
        .foregroundStyle(step.satisfied ? HubTheme.cyan : HubTheme.textSecondary)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(step.title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(HubTheme.textPrimary)
          statusChip(step.status)
        }
        Text(step.detail)
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
    }
    .padding(.vertical, 4)
  }

  private var operatorPanel: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Operator Ceremony")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(HubTheme.textPrimary)
          Spacer()
          Button {
            copyOperatorCommand()
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
          }
          .buttonStyle(.bordered)
        }
        Text("Trust grants and context passports stay operator CLI ceremonies; this app opens the read-only action helper so the current DB state chooses the exact no-heredoc command.")
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        ScrollView(.horizontal) {
          Text(operatorCommand)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(HubTheme.textPrimary)
            .textSelection(.enabled)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.white.opacity(0.62), in: RoundedRectangle(cornerRadius: 8))
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

  private func copyOperatorCommand() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(operatorCommand, forType: .string)
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
