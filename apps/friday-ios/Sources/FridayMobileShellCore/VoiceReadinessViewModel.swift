import Foundation

public enum MobileVoiceAuthorizationStatus: String, Sendable, Equatable {
  case notDetermined = "not_determined"
  case denied
  case restricted
  case authorized
  case unavailable
  case unknown
}

public struct MobileVoiceReadiness: Sendable, Equatable {
  public let microphone: MobileVoiceAuthorizationStatus
  public let speechRecognition: MobileVoiceAuthorizationStatus
  public let ttsProviderConfigured: Bool
  public let truthLabel: String

  public init(
    microphone: MobileVoiceAuthorizationStatus,
    speechRecognition: MobileVoiceAuthorizationStatus,
    ttsProviderConfigured: Bool = false,
    truthLabel: String = "mobile_voice_readiness_local_only"
  ) {
    self.microphone = microphone
    self.speechRecognition = speechRecognition
    self.ttsProviderConfigured = ttsProviderConfigured
    self.truthLabel = truthLabel
  }

  public var canRequestPermission: Bool {
    microphone == .notDetermined || speechRecognition == .notDetermined
  }

  public var speechCaptureReady: Bool {
    microphone == .authorized && speechRecognition == .authorized
  }

  public var voiceLoopReady: Bool {
    speechCaptureReady && ttsProviderConfigured
  }

  public var summary: String {
    if voiceLoopReady {
      return "Voice capture and TTS provider readiness are both present."
    }
    if speechCaptureReady {
      return "Voice capture is allowed; TTS provider output is not configured in this build."
    }
    if microphone == .notDetermined || speechRecognition == .notDetermined {
      return "Voice permissions have not both been requested."
    }
    if microphone == .denied || speechRecognition == .denied {
      return "Voice input is denied in system settings."
    }
    if microphone == .restricted || speechRecognition == .restricted {
      return "Voice input is restricted by the device policy."
    }
    return "Voice readiness is unavailable."
  }
}

public protocol MobileVoiceReadinessAuthorizing: Sendable {
  func currentReadiness() async throws -> MobileVoiceReadiness
  func requestVoiceAuthorization() async throws -> MobileVoiceReadiness
}

public enum MobileVoiceReadinessState: Sendable, Equatable {
  case idle
  case loading
  case loaded(MobileVoiceReadiness)
  case unavailable(String)

  public var readiness: MobileVoiceReadiness? {
    if case let .loaded(readiness) = self { return readiness }
    return nil
  }
}

@MainActor
public final class VoiceReadinessViewModel: ObservableObject {
  @Published public private(set) var state: MobileVoiceReadinessState = .idle

  private let authorizer: any MobileVoiceReadinessAuthorizing

  public init(authorizer: any MobileVoiceReadinessAuthorizing) {
    self.authorizer = authorizer
  }

  public func refresh() async {
    state = .loading
    do {
      state = .loaded(try await authorizer.currentReadiness())
    } catch {
      state = .unavailable("\(error)")
    }
  }

  public func requestPermission() async {
    state = .loading
    do {
      state = .loaded(try await authorizer.requestVoiceAuthorization())
    } catch {
      state = .unavailable("\(error)")
    }
  }
}
