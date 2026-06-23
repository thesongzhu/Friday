import AVFoundation
import SwiftUI
import UIKit

struct PairingQRScannerView: UIViewControllerRepresentable {
  let onScan: (String) -> Void
  let onCancel: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onScan: onScan)
  }

  func makeUIViewController(context: Context) -> ScannerViewController {
    let controller = ScannerViewController()
    controller.delegate = context.coordinator
    controller.onCancel = onCancel
    return controller
  }

  func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}

  final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    private let onScan: (String) -> Void
    private var delivered = false

    init(onScan: @escaping (String) -> Void) {
      self.onScan = onScan
    }

    func metadataOutput(
      _ output: AVCaptureMetadataOutput,
      didOutput metadataObjects: [AVMetadataObject],
      from connection: AVCaptureConnection
    ) {
      guard !delivered,
        let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
        object.type == .qr,
        let value = object.stringValue
      else {
        return
      }
      delivered = true
      onScan(value)
    }
  }
}

final class ScannerViewController: UIViewController {
  weak var delegate: AVCaptureMetadataOutputObjectsDelegate?
  var onCancel: (() -> Void)?

  private let session = AVCaptureSession()
  private var previewLayer: AVCaptureVideoPreviewLayer?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    configureCancelButton()
    configureScanner()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    session.stopRunning()
  }

  private func configureCancelButton() {
    let button = UIButton(type: .system)
    button.setTitle("Cancel", for: .normal)
    button.tintColor = .white
    button.backgroundColor = UIColor.black.withAlphaComponent(0.46)
    button.layer.cornerRadius = 8
    button.translatesAutoresizingMaskIntoConstraints = false
    button.addAction(UIAction { [weak self] _ in self?.onCancel?() }, for: .touchUpInside)
    view.addSubview(button)
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
      button.widthAnchor.constraint(equalToConstant: 88),
      button.heightAnchor.constraint(equalToConstant: 40),
    ])
  }

  private func configureScanner() {
    guard AVCaptureDevice.authorizationStatus(for: .video) != .denied,
      let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      showUnavailable()
      return
    }

    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      showUnavailable()
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(delegate, queue: .main)
    output.metadataObjectTypes = [.qr]

    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.insertSublayer(preview, at: 0)
    previewLayer = preview

    DispatchQueue.global(qos: .userInitiated).async { [session] in
      session.startRunning()
    }
  }

  private func showUnavailable() {
    let label = UILabel()
    label.text = "Camera is unavailable"
    label.textColor = .white
    label.textAlignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }
}
