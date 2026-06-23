import AVFoundation
import FridayMobileShellCore
import Speech

struct SystemVoiceReadinessAuthorizer: MobileVoiceReadinessAuthorizing {
  private let ttsProviderConfigured: Bool

  init(ttsProviderConfigured: Bool = false) {
    self.ttsProviderConfigured = ttsProviderConfigured
  }

  func currentReadiness() async throws -> MobileVoiceReadiness {
    MobileVoiceReadiness(
      microphone: Self.microphoneStatus(AVAudioApplication.shared.recordPermission),
      speechRecognition: Self.speechStatus(SFSpeechRecognizer.authorizationStatus()),
      ttsProviderConfigured: ttsProviderConfigured)
  }

  func requestVoiceAuthorization() async throws -> MobileVoiceReadiness {
    let microphone = await requestMicrophoneStatus()
    let speech = await requestSpeechStatus()
    return MobileVoiceReadiness(
      microphone: microphone,
      speechRecognition: speech,
      ttsProviderConfigured: ttsProviderConfigured)
  }

  private func requestMicrophoneStatus() async -> MobileVoiceAuthorizationStatus {
    await withCheckedContinuation { continuation in
      AVAudioApplication.requestRecordPermission { granted in
        let status = granted
          ? MobileVoiceAuthorizationStatus.authorized
          : Self.microphoneStatus(AVAudioApplication.shared.recordPermission)
        continuation.resume(returning: status)
      }
    }
  }

  private func requestSpeechStatus() async -> MobileVoiceAuthorizationStatus {
    await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: Self.speechStatus(status))
      }
    }
  }

  private static func microphoneStatus(
    _ status: AVAudioApplication.recordPermission
  ) -> MobileVoiceAuthorizationStatus {
    switch status {
    case .undetermined:
      return .notDetermined
    case .denied:
      return .denied
    case .granted:
      return .authorized
    @unknown default:
      return .unknown
    }
  }

  private static func speechStatus(
    _ status: SFSpeechRecognizerAuthorizationStatus
  ) -> MobileVoiceAuthorizationStatus {
    switch status {
    case .notDetermined:
      return .notDetermined
    case .denied:
      return .denied
    case .restricted:
      return .restricted
    case .authorized:
      return .authorized
    @unknown default:
      return .unknown
    }
  }
}
