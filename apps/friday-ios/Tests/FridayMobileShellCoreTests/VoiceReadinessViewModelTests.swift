import XCTest
@testable import FridayMobileShellCore

@MainActor
final class VoiceReadinessViewModelTests: XCTestCase {
  struct FakeVoiceAuthorizer: MobileVoiceReadinessAuthorizing {
    let current: MobileVoiceReadiness
    let requested: MobileVoiceReadiness

    func currentReadiness() async throws -> MobileVoiceReadiness {
      current
    }

    func requestVoiceAuthorization() async throws -> MobileVoiceReadiness {
      requested
    }
  }

  func testVoiceLoopReadyRequiresCaptureAndTtsProvider() {
    let captureOnly = MobileVoiceReadiness(
      microphone: .authorized,
      speechRecognition: .authorized,
      ttsProviderConfigured: false)
    XCTAssertTrue(captureOnly.speechCaptureReady)
    XCTAssertFalse(captureOnly.voiceLoopReady)
    XCTAssertEqual(
      captureOnly.summary,
      "Voice capture is allowed; speech output provider is not configured in this build.")

    let complete = MobileVoiceReadiness(
      microphone: .authorized,
      speechRecognition: .authorized,
      ttsProviderConfigured: true)
    XCTAssertTrue(complete.voiceLoopReady)
    XCTAssertEqual(
      complete.summary,
      "Voice capture and local speech output provider readiness are both present.")
  }

  func testDeniedOrRestrictedPermissionsNeverClaimVoiceReady() {
    let denied = MobileVoiceReadiness(
      microphone: .denied,
      speechRecognition: .authorized,
      ttsProviderConfigured: true)
    XCTAssertFalse(denied.speechCaptureReady)
    XCTAssertFalse(denied.voiceLoopReady)
    XCTAssertEqual(denied.summary, "Voice input is denied in system settings.")

    let restricted = MobileVoiceReadiness(
      microphone: .authorized,
      speechRecognition: .restricted,
      ttsProviderConfigured: true)
    XCTAssertFalse(restricted.speechCaptureReady)
    XCTAssertFalse(restricted.voiceLoopReady)
    XCTAssertEqual(restricted.summary, "Voice input is restricted by the device policy.")
  }

  func testRefreshAndRequestPermissionUseAuthoritativeAuthorizerState() async {
    let vm = VoiceReadinessViewModel(authorizer: FakeVoiceAuthorizer(
      current: MobileVoiceReadiness(
        microphone: .notDetermined,
        speechRecognition: .notDetermined,
        ttsProviderConfigured: false),
      requested: MobileVoiceReadiness(
        microphone: .authorized,
        speechRecognition: .authorized,
        ttsProviderConfigured: false)))

    await vm.refresh()
    guard case .loaded(let initial) = vm.state else {
      return XCTFail("expected loaded initial state, got \(vm.state)")
    }
    XCTAssertTrue(initial.canRequestPermission)
    XCTAssertFalse(initial.voiceLoopReady)

    await vm.requestPermission()
    guard case .loaded(let requested) = vm.state else {
      return XCTFail("expected loaded requested state, got \(vm.state)")
    }
    XCTAssertTrue(requested.speechCaptureReady)
    XCTAssertFalse(
      requested.voiceLoopReady,
      "requesting OS capture permissions must not fabricate TTS provider readiness")
  }

  func testActionRowsSeparatePermissionCaptureTtsAndRealtimeLoopTruth() {
    let initial = MobileVoiceReadiness(
      microphone: .notDetermined,
      speechRecognition: .notDetermined,
      ttsProviderConfigured: false)
    let initialRows = VoiceReadinessViewModel.actionRows(for: initial)
    XCTAssertEqual(initialRows.map(\.id), [
      "permission",
      "speech-capture",
      "tts-output",
      "realtime-loop",
      "open-chat-loop",
    ])
    XCTAssertEqual(initialRows.first { $0.id == "permission" }?.truthLabel, "native_permission_request")
    XCTAssertEqual(initialRows.first { $0.id == "permission" }?.enabled, true)
    XCTAssertEqual(initialRows.first { $0.id == "tts-output" }?.truthLabel, "NO-GO")
    XCTAssertEqual(initialRows.first { $0.id == "tts-output" }?.enabled, false)
    XCTAssertEqual(initialRows.first { $0.id == "realtime-loop" }?.truthLabel, "blocked")
    XCTAssertEqual(initialRows.first { $0.id == "realtime-loop" }?.enabled, false)
    XCTAssertEqual(initialRows.first { $0.id == "open-chat-loop" }?.truthLabel, "blocked")
    XCTAssertEqual(initialRows.first { $0.id == "open-chat-loop" }?.enabled, false)

    let captureOnly = MobileVoiceReadiness(
      microphone: .authorized,
      speechRecognition: .authorized,
      ttsProviderConfigured: false)
    let captureRows = VoiceReadinessViewModel.actionRows(for: captureOnly)
    XCTAssertEqual(captureRows.first { $0.id == "permission" }?.enabled, false)
    XCTAssertEqual(captureRows.first { $0.id == "speech-capture" }?.enabled, true)
    XCTAssertEqual(captureRows.first { $0.id == "tts-output" }?.truthLabel, "NO-GO")
    XCTAssertEqual(captureRows.first { $0.id == "realtime-loop" }?.enabled, false)

    let complete = MobileVoiceReadiness(
      microphone: .authorized,
      speechRecognition: .authorized,
      ttsProviderConfigured: true)
    let completeRows = VoiceReadinessViewModel.actionRows(for: complete)
    XCTAssertEqual(completeRows.first { $0.id == "tts-output" }?.truthLabel, "provider_configured")
    XCTAssertEqual(completeRows.first { $0.id == "tts-output" }?.detail, "Local speech output provider is configured.")
    XCTAssertEqual(completeRows.first { $0.id == "realtime-loop" }?.truthLabel, "ready")
    XCTAssertEqual(completeRows.first { $0.id == "realtime-loop" }?.enabled, true)
    XCTAssertEqual(completeRows.first { $0.id == "open-chat-loop" }?.truthLabel, "native_voice_route_ready")
    XCTAssertEqual(completeRows.first { $0.id == "open-chat-loop" }?.enabled, true)
  }
}
