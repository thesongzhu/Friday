import FridayMobileShellCore
import AVFoundation
import FridayRustClient
@preconcurrency import Speech
import SwiftUI

/// The full-screen, pet-centered Friday Chat read-WRITE surface (locked: the Friday Chat entry
/// is the top-bar 💬; the composer lives HERE, on a separate screen — never as an on-Home card).
///
/// This is the strict S6 needle: the 4-state chat loop over the package's REAL
/// `SealedWSWriteClient` + the `OperatorSigner` relay (driven by `FridayChatViewModel`):
///   compose → send → owner-gated readable answer; mutating → AgentRunPaused → S6 approval card →
///   operator-signs (relay-only) → resumeWithApproval VERBATIM → refs-only receipt; and
///   honest-unavailable when the Rust write server is DARK (the EXPECTED slice-6 state).
///
/// Truth rules (enforced in the view model): INV-1 (no signing key on the app — the phone relays
/// an OPAQUE blob), INV-2 (a mutation executes ONLY via an operator-approved resume), INV-5
/// (the write receipt is refs-only; the answer body appears only through the owner-gated readback).
struct FridayChatScreen: View {
  @StateObject private var viewModel: FridayChatViewModel
  @StateObject private var voice = MobileVoiceController()
  /// Whether the S6 pause/approve/resume is enabled (the run-control flag). OFF ⇒ read-only.
  private let runControlEnabled: Bool
  @State private var routePreference: MissionRoutePreference = .auto
  @State private var draft: String

  init(session: FridaySession, launchContext: ChatLaunchContext? = nil) {
    self.runControlEnabled = session.runControlEnabled
    _draft = State(initialValue: launchContext?.composerPrefill ?? "")
    _viewModel = StateObject(wrappedValue: FridayChatViewModel(
      writeClient: session.writeClient,
      signer: session.signer,
      missionClient: session.missionClient,
      readClient: session.readClient,
      launchContext: launchContext))
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          Spacer(minLength: 12)
          // Pet-centered: the Hero Pet anchors the chat surface.
          HeroPet()
          Text("Friday Chat")
            .font(.title3).bold()
            .foregroundStyle(MobileTheme.textPrimary)

          historyCard
          phaseCard
          contextCards
        }
        .padding(16)
      }
      composer
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
    .navigationTitle("Friday Chat")
    .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder private var contextCards: some View {
    if !viewModel.contextCards.isEmpty {
      GlassPanel {
        VStack(alignment: .leading, spacing: 10) {
          Text("Next")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          ForEach(viewModel.contextCards) { card in
            contextCardRow(card)
          }
        }
      }
      .accessibilityIdentifier("friday.chat.context-cards")
    }
  }

  private func contextCardRow(_ card: ChatContextCard) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: contextCardIcon(card.id))
        .foregroundStyle(MobileTheme.cyan)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 3) {
        HStack {
          Text(card.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          FridayChip(text: card.truthLabel, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
        }
        Text(card.detail)
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        FridayProofLine(label: "evidence", ref: short(card.evidenceRef))
        if isVoiceLaunchCard(card) {
          Text("Voice route opened")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(MobileTheme.cyan)
            .accessibilityIdentifier("friday.voice.open-chat-loop")
          Text("Voice permission continues through the Chat microphone control")
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
            .accessibilityIdentifier("friday.voice.permission")
        }
        if card.id == "handoff" {
          handoffControls
        }
        if card.id == "handoff", let state = viewModel.contextPassportTransferState {
          candidateDecisionStateView(state)
        }
        if card.id == "memory", card.memoryCandidateId != nil {
          memoryDecisionControls
        }
        if card.id == "memory", let state = viewModel.contextMemoryDecisionState {
          candidateDecisionStateView(state)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .onTapGesture { viewModel.selectContextCard(card.id) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(card.title) card")
    .accessibilityIdentifier("friday.chat.\(card.id)-card")
  }

  private func isVoiceLaunchCard(_ card: ChatContextCard) -> Bool {
    card.id == "launch" && card.detail.lowercased().hasPrefix("voice submitted")
  }

  private func contextCardIcon(_ id: String) -> String {
    switch id {
    case "handoff": return "arrowshape.turn.up.right"
    case "launch": return "link.badge.plus"
    default: return "brain.head.profile"
    }
  }

  private var handoffControls: some View {
    Button {
      Task { await viewModel.submitContextPassportHandoff() }
    } label: {
      Label("Create handoff", systemImage: "arrowshape.turn.up.right")
        .font(.caption.weight(.semibold))
    }
    .buttonStyle(FridayButtonStyle(variant: .secondary))
    .disabled(viewModel.contextPassportTransferState?.isSent == true)
    .accessibilityIdentifier("friday.chat.handoff-card.share")
  }

  private var memoryDecisionControls: some View {
    HStack(spacing: 8) {
      Button {
        Task { await viewModel.decideContextMemory(confirm: true) }
      } label: {
        Image(systemName: "checkmark")
          .frame(width: 26, height: 26)
      }
      .buttonStyle(FridayButtonStyle(variant: .primary))
      .tint(MobileTheme.cyan)
      .disabled(viewModel.contextMemoryDecisionState?.isSent == true)
      .accessibilityLabel("Keep memory candidate")
      .accessibilityIdentifier("friday.chat.memory-card.keep")

      Button {
        Task { await viewModel.decideContextMemory(confirm: false) }
      } label: {
        Image(systemName: "xmark")
          .frame(width: 26, height: 26)
      }
      .buttonStyle(FridayButtonStyle(variant: .secondary))
      .disabled(viewModel.contextMemoryDecisionState?.isSent == true)
      .accessibilityLabel("Reject memory candidate")
      .accessibilityIdentifier("friday.chat.memory-card.reject")
    }
  }

  @ViewBuilder private func candidateDecisionStateView(_ state: HomeLearningDecisionState) -> some View {
    switch state {
    case .sent:
      FridayChip(text: "sending", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
    case .confirmed(let summary):
      Text(summary)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    case .error(let reason):
      Text(reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.chipWarnFG)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: - The 4-state loop, rendered

  @ViewBuilder private var historyCard: some View {
    if !viewModel.history.isEmpty {
      GlassPanel {
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Label("History", systemImage: "clock.arrow.circlepath")
              .font(.headline)
              .foregroundStyle(MobileTheme.textPrimary)
            Spacer()
            Button("Clear") { viewModel.clearHistory() }
              .font(.caption)
              .foregroundStyle(MobileTheme.cyan)
              .accessibilityLabel("Clear Friday chat history")
          }
          ForEach(viewModel.history.suffix(8)) { item in
            VStack(alignment: .leading, spacing: 4) {
              Text(item.role == "you" ? "You" : "Friday")
                .font(.caption2)
                .foregroundStyle(MobileTheme.textSecondary)
              Text(item.text)
                .font(.caption)
                .foregroundStyle(MobileTheme.textPrimary)
                .lineLimit(4)
              if item.receiptRefs.isEmpty, let runId = item.runId {
                FridayProofLine(label: "run_id", ref: short(runId))
              } else if !item.receiptRefs.isEmpty {
                receiptRefs(item.receiptRefs, limit: 4)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 3)
          }
        }
      }
      .accessibilityIdentifier("friday.chat.history")
    }
  }

  @ViewBuilder private var phaseCard: some View {
    switch viewModel.phase {
    case .composing:
      placeholder(
        "Ask Friday anything.",
        "Answers are refs-only (a fingerprint + counts). "
          + (runControlEnabled
            ? "A mutating action pauses for your approval."
            : "Read-only — approvals are not available yet."))
    case .dispatching(let task):
      GlassPanel {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) { ProgressView(); Text("Friday is working…").font(.headline) }
          Text(task).font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .answered(let r):
      answerCard(r)
    case .pendingApproval(let card):
      approvalCard(card)
    case .resuming(let card):
      GlassPanel {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) { ProgressView(); Text("Relaying your approval…").font(.headline) }
          Text("\(card.actionVerb) · \(short(card.actionDigest))")
            .font(.caption2).monospaced().foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .rejecting(let card):
      GlassPanel {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) { ProgressView(); Text("Rejecting approval…").font(.headline) }
          Text("\(card.actionVerb) · \(short(card.actionDigest))")
            .font(.caption2).monospaced().foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .resumed(let r):
      resumeCard(r)
    case .unavailable(let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Image(systemName: "wifi.slash").foregroundStyle(MobileTheme.coral)
            Text("Connect Friday").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          }
          Text(userFacingChatReason(reason)).font(.caption2).foregroundStyle(MobileTheme.textSecondary)
          Button("Start over") { viewModel.newTurn() }
            .font(.caption).foregroundStyle(MobileTheme.cyan)
            .accessibilityLabel("Start a new Friday chat turn")
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Connect Friday. \(userFacingChatReason(reason))")
      .accessibilityIdentifier("friday.chat.unavailable")
    }
  }

  private func userFacingChatReason(_ reason: String) -> String {
    let normalized = reason.lowercased()
    if normalized.contains("approval") {
      return "Friday needs approval before this action can continue."
    }
    if normalized.contains("offline") || normalized.contains("transport") || normalized.contains("connection") {
      return "Friday cannot reach the live Hub from this device. Check the connection, then try again."
    }
    if normalized.contains("paused") {
      return "Friday paused safely and needs your review before continuing."
    }
    return "Friday needs a fresh live connection before this turn can continue."
  }

  // MARK: - Composer (Compose → Send)

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      Picker("Route", selection: $routePreference) {
        ForEach(MissionRoutePreference.allCases) { preference in
          Text(preference.title).tag(preference)
        }
      }
      .pickerStyle(.segmented)
      .disabled(viewModel.phase.isBusy || viewModel.phase.isAwaitingApproval)
      .accessibilityLabel("Route preference")
      .accessibilityIdentifier("friday.chat.route-preference")

      HStack(spacing: 10) {
        Button {
          voice.toggleRecording { transcript in
            Task { @MainActor in
              draft = transcript
            }
          }
        } label: {
          Image(systemName: voice.isRecording ? "stop.circle.fill" : "mic.circle.fill")
            .font(.system(size: 28))
            .foregroundStyle(voice.isRecording ? MobileTheme.coral : MobileTheme.cyan)
        }
        .disabled(viewModel.phase.isBusy || viewModel.phase.isAwaitingApproval)
        .accessibilityLabel(voice.isRecording ? "Stop voice input" : "Start voice input")
        .accessibilityIdentifier("friday.chat.voice-input")

        Button {
          voice.speak("Friday voice output is ready.")
        } label: {
          Image(systemName: "speaker.wave.2.circle.fill")
            .font(.system(size: 26))
            .foregroundStyle(MobileTheme.cyan)
        }
        .disabled(viewModel.phase.isBusy || viewModel.phase.isAwaitingApproval)
        .accessibilityLabel("Test Friday voice output")
        .accessibilityIdentifier("friday.chat.voice-output")

        TextField("Ask Friday…", text: $draft, axis: .vertical)
          .textFieldStyle(.plain)
          .lineLimit(1...4)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
              .fill(Color.black.opacity(0.05)))
          .disabled(viewModel.phase.isBusy || viewModel.phase.isAwaitingApproval)
          .accessibilityLabel("Message Friday")
          .accessibilityIdentifier("friday.chat.composer")

        Button {
          voice.stopRecording()
          let task = draft
          draft = ""
          Task { await viewModel.send(task, routePreference: routePreference) }
        } label: {
          Image(systemName: "arrow.up.circle.fill")
            .font(.system(size: 30))
            .foregroundStyle(canSend ? MobileTheme.cyan : MobileTheme.cyan.opacity(0.25))
        }
        .disabled(!canSend)
        .accessibilityLabel("Send message to Friday")
        .accessibilityIdentifier("friday.chat.send")
      }
      if let voiceStatus = voice.status {
        Text(voiceStatus)
          .font(.caption2)
          .foregroundStyle(voice.isRecording ? MobileTheme.cyan : MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(.ultraThinMaterial)
  }

  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !viewModel.phase.isBusy && !viewModel.phase.isAwaitingApproval
  }

  // MARK: - Cards

  /// The answer receipt: readable body when the owner-gated readback grants it, refs otherwise.
  private func answerCard(_ r: ChatAnswerReceipt) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          FridayChip(text: r.status.uppercased(), bg: MobileTheme.chipDoneBG, fg: MobileTheme.chipDoneFG)
          Spacer()
          Button("New") { viewModel.newTurn() }.font(.caption).foregroundStyle(MobileTheme.cyan)
        }
        Text("Friday answered").font(.headline).foregroundStyle(MobileTheme.textPrimary)
        if let answer = readableAnswer(r.answerBody) {
          HStack {
            Button {
              voice.speak(answer)
            } label: {
              Label("Speak", systemImage: "speaker.wave.2.fill")
            }
            .buttonStyle(FridayButtonStyle(variant: .secondary))
            .tint(MobileTheme.cyan)
            .accessibilityLabel("Speak Friday answer")
            .accessibilityIdentifier("friday.chat.voice-output")

            Button {
              voice.stopSpeaking()
            } label: {
              Image(systemName: "speaker.slash.fill")
            }
            .buttonStyle(FridayButtonStyle(variant: .secondary))
            .accessibilityLabel("Stop speaking Friday answer")
          }
          Text(answer)
            .font(.body)
            .foregroundStyle(MobileTheme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
          if let runId = r.answerBodyRunId {
            FridayProofLine(label: "answer_body_run_id", ref: runId)
          }
        } else {
          Text("Answer body is not available from the owner-gated readback yet.")
            .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        }
        receiptRefs(r.receiptRefs)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Friday answer")
    .accessibilityIdentifier("friday.chat.answer")
  }

  /// The S6 approval card — summary-then-proof (the verb + summary, then the digest the operator
  /// signs over). Refs-only; carries NO signing material (INV-1). The app relays an OPAQUE blob.
  private func approvalCard(_ card: ApprovalCard) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Image(systemName: "hand.raised.fill").foregroundStyle(MobileTheme.coral)
          Text("Approval required").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          FridayChip(text: card.truthLabel, bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
        }
        // SUMMARY (what paused) — a coarse verb + the owner-sealed summary.
        Text(card.actionVerb).font(.title3).bold().foregroundStyle(MobileTheme.textPrimary)
        if let summary = card.ownerSealedSummary {
          Text(summary).font(.callout).foregroundStyle(MobileTheme.textPrimary)
        }
        // PROOF (the digest the operator signs over) — never a body.
        FridayProofLine(label: "action_digest", ref: short(card.actionDigest))
        FridayProofLine(label: "approval_id", ref: card.approvalId)
        Text("Friday paused this mutating action. Approving asks the operator signer for a "
          + "signature; the phone relays it but never signs (INV-1).")
          .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        HStack(spacing: 12) {
          Button {
            Task { await viewModel.approve() }
          } label: {
            Label("Approve", systemImage: "checkmark.seal").bold()
          }
          .buttonStyle(FridayButtonStyle(variant: .primary))
          .accessibilityLabel("Approve Friday action")
          .accessibilityIdentifier("friday.chat.approval.approve")
          Button(role: .destructive) {
            Task { await viewModel.reject() }
          } label: {
            Label("Reject", systemImage: "xmark").foregroundStyle(MobileTheme.coral)
          }
          .buttonStyle(FridayButtonStyle(variant: .secondary))
          .accessibilityLabel("Reject Friday action")
          .accessibilityIdentifier("friday.chat.approval.reject")
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Approval required for \(card.actionVerb)")
    .accessibilityIdentifier("friday.chat.approval-card")
  }

  /// The refs-only control receipt (resume/reject/cancel).
  private func resumeCard(_ r: ChatResumeReceipt) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          FridayChip(
            text: r.statusLabel,
            bg: r.accepted ? MobileTheme.chipDoneBG : MobileTheme.chipWarnBG,
            fg: r.accepted ? MobileTheme.chipDoneFG : MobileTheme.chipWarnFG)
          Spacer()
          Button("New") { viewModel.newTurn() }.font(.caption).foregroundStyle(MobileTheme.cyan)
        }
        Text(r.title)
          .font(.headline).foregroundStyle(MobileTheme.textPrimary)
        receiptRefs(r.receiptRefs)
        Text(r.detail)
          .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(r.title)
    .accessibilityIdentifier("friday.chat.resume-receipt")
  }

  private func placeholder(_ title: String, _ sub: String) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.headline).foregroundStyle(MobileTheme.textPrimary)
        Text(sub).font(.caption2).foregroundStyle(MobileTheme.textSecondary)
      }
    }
  }

  private func short(_ s: String) -> String {
    s.count > 16 ? "\(s.prefix(10))…\(s.suffix(4))" : s
  }

  private func readableAnswer(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    return trimmed
  }

  private func receiptRefs(_ refs: [ChatReceiptRef], limit: Int? = nil) -> some View {
    let visibleRefs = limit.map { Array(refs.prefix($0)) } ?? refs
    return VStack(alignment: .leading, spacing: 4) {
      ForEach(visibleRefs) { ref in
        FridayProofLine(label: ref.label, ref: short(ref.ref))
      }
      if let limit, refs.count > limit {
        FridayProofLine(label: "more_refs", ref: "+\(refs.count - limit)")
      }
    }
    .accessibilityIdentifier("friday.chat.receipt-refs")
  }
}

#if DEBUG
#Preview("Friday Chat · live write client (dark ⇒ honest-unavailable)") {
  NavigationStack { FridayChatScreen(session: FridaySession()) }
}
#endif

@MainActor
private final class MobileVoiceController: ObservableObject {
  @Published var isRecording = false
  @Published var status: String?

  private let recognizer = SFSpeechRecognizer()
  private let audioEngine = AVAudioEngine()
  private let synthesizer = AVSpeechSynthesizer()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?

  func toggleRecording(onTranscript: @escaping @Sendable (String) -> Void) {
    if isRecording {
      stopRecording()
    } else {
      startRecording(onTranscript: onTranscript)
    }
  }

  func startRecording(onTranscript: @escaping @Sendable (String) -> Void) {
    guard let recognizer, recognizer.isAvailable else {
      status = "Voice input needs microphone and speech recognition support on this device."
      return
    }
    SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
      Self.requestMicrophoneAccess { micAllowed in
        Task { @MainActor in
          guard let self else { return }
          guard speechStatus == .authorized, micAllowed else {
            self.status = "Voice input needs microphone and speech recognition permission."
            return
          }
          self.beginRecognition(onTranscript: onTranscript)
        }
      }
    }
  }

  func stopRecording() {
    guard isRecording || audioEngine.isRunning else { return }
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
    request?.endAudio()
    task?.cancel()
    request = nil
    task = nil
    isRecording = false
    deactivateAudioSession()
    status = "Voice input stopped."
  }

  func speak(_ text: String) {
    stopRecording()
    stopSpeaking()
    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
      try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      status = "Voice output failed: \(error.localizedDescription)"
      return
    }
    let utterance = AVSpeechUtterance(string: text)
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate
    synthesizer.speak(utterance)
    status = "Speaking Friday answer."
  }

  func stopSpeaking() {
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
      status = "Voice output stopped."
    }
  }

  private func beginRecognition(
    onTranscript: @escaping @Sendable (String) -> Void
  ) {
    guard let recognizer else {
      status = "Voice input needs microphone and speech recognition support on this device."
      return
    }
    stopRecording()
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    self.request = request

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }

    do {
      try AVAudioSession.sharedInstance().setCategory(.record, mode: .measurement, options: .duckOthers)
      try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
      audioEngine.prepare()
      try audioEngine.start()
      isRecording = true
      status = "Listening..."
      task = recognizer.recognitionTask(with: request) { [weak self] result, error in
        Task { @MainActor in
          guard let self else { return }
          if let result {
            onTranscript(result.bestTranscription.formattedString)
          }
          if let error {
            self.status = "Voice input stopped: \(error.localizedDescription)"
            self.stopRecording()
          } else if result?.isFinal == true {
            self.stopRecording()
          }
        }
      }
    } catch {
      input.removeTap(onBus: 0)
      deactivateAudioSession()
      self.request = nil
      status = "Voice input failed: \(error.localizedDescription)"
    }
  }

  private func deactivateAudioSession() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private static func requestMicrophoneAccess(_ completion: @escaping @Sendable (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: completion)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(completion)
    }
  }
}
