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
      return "Voice capture and local speech output provider readiness are both present."
    }
    if speechCaptureReady {
      return "Voice capture is allowed; speech output provider is not configured in this build."
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

public struct MobileVoiceActionRow: Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let detail: String
  public let truthLabel: String
  public let enabled: Bool

  public init(id: String, title: String, detail: String, truthLabel: String, enabled: Bool) {
    self.id = id
    self.title = title
    self.detail = detail
    self.truthLabel = truthLabel
    self.enabled = enabled
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

  public static func actionRows(for readiness: MobileVoiceReadiness) -> [MobileVoiceActionRow] {
    [
      MobileVoiceActionRow(
        id: "permission",
        title: "Request OS permission",
        detail: readiness.canRequestPermission
          ? "Asks iOS for microphone and speech recognition permission."
          : "Permission state is already decided by iOS.",
        truthLabel: "native_permission_request",
        enabled: readiness.canRequestPermission),
      MobileVoiceActionRow(
        id: "speech-capture",
        title: "Speech capture",
        detail: readiness.speechCaptureReady
          ? "Microphone and speech recognition are both authorized."
          : "Blocked until microphone and speech recognition are authorized.",
        truthLabel: "local_capture_readiness",
        enabled: readiness.speechCaptureReady),
      MobileVoiceActionRow(
        id: "tts-output",
        title: "Speech output",
        detail: readiness.ttsProviderConfigured
          ? "Local speech output provider is configured."
          : "No speech output provider is configured in this build.",
        truthLabel: readiness.ttsProviderConfigured ? "provider_configured" : "NO-GO",
        enabled: readiness.ttsProviderConfigured),
      MobileVoiceActionRow(
        id: "realtime-loop",
        title: "Realtime voice loop",
        detail: readiness.voiceLoopReady
          ? "Capture and TTS are both ready; open Friday Chat to speak with the governed loop."
          : "Disabled until capture and TTS are both ready.",
        truthLabel: readiness.voiceLoopReady ? "ready" : "blocked",
        enabled: readiness.voiceLoopReady),
      MobileVoiceActionRow(
        id: "open-chat-loop",
        title: "Open Friday Chat voice loop",
        detail: readiness.voiceLoopReady
          ? "Routes to Friday Chat, where mic input and speech output are wired to the live governed turn."
          : "Blocked until voice capture and speech output are both ready.",
        truthLabel: readiness.voiceLoopReady ? "native_voice_route_ready" : "blocked",
        enabled: readiness.voiceLoopReady),
    ]
  }
}
