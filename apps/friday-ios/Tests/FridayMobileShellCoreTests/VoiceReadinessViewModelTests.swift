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
      "Voice capture is allowed; TTS provider output is not configured in this build.")

    let complete = MobileVoiceReadiness(
      microphone: .authorized,
      speechRecognition: .authorized,
      ttsProviderConfigured: true)
    XCTAssertTrue(complete.voiceLoopReady)
    XCTAssertEqual(
      complete.summary,
      "Voice capture and TTS provider readiness are both present.")
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
}
