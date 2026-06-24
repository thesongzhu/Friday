import FridayHubConsoleCore
import AVFoundation
@preconcurrency import Speech
import SwiftUI

struct DesktopChatScreen: View {
  @ObservedObject var viewModel: OperationsOverviewViewModel
  @StateObject private var voice = DesktopVoiceController()
  @State private var draft = ""
  @State private var routePreference: MissionRoutePreference = .auto
  @State private var history: [DesktopChatMessage]

  private let historyStore: DesktopChatHistoryStore

  init(
    viewModel: OperationsOverviewViewModel,
    historyStore: DesktopChatHistoryStore = DesktopChatHistoryStore()
  ) {
    self.viewModel = viewModel
    self.historyStore = historyStore
    _history = State(initialValue: historyStore.load())
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      switch viewModel.state {
      case .idle, .loading:
        loadingView
      case let .loaded(snapshot):
        ScrollView {
          loadedContent(snapshot)
        }
      case let .unavailable(reason):
        UnavailableView(reason: reason)
      }
      composer
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(HubTheme.backgroundWarmOffWhite)
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "bubble.left.and.bubble.right")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(HubTheme.cyan)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text("Friday Chat")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Text("Mission-backed desktop conversation")
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
      Spacer()
      Button {
        Task { await viewModel.refresh() }
      } label: {
        Label("Refresh Status", systemImage: "arrow.clockwise")
      }
      .buttonStyle(.borderedProminent)
      .tint(HubTheme.cyan)
      .disabled(viewModel.state.isLoading)
      .accessibilityLabel("Refresh Friday Chat status")
      .accessibilityIdentifier("friday.desktop.chat.refresh")
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
  }

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading hub projection...")
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder
  func loadedContent(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      if !snapshot.statusLabels.isEmpty || !snapshot.runtimeFeedStatus.isHealthy {
        StatusBanner(snapshot: snapshot)
      }
      continuityCard(snapshot)
      transcriptCard
      stateCard
      reviewCard(snapshot)
    }
    .padding(20)
  }

  private func continuityCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Conversation")
          Spacer()
          snapshot.runtimeFeedStatus.isHealthy
            ? StatusChip(
              text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipPendingBG,
              fg: HubTheme.chipPendingFG)
            : StatusChip(
              text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipWarnBG,
              fg: HubTheme.chipWarnFG)
        }
        RefPill(label: "mission_id", ref: snapshot.missionId)
        RefPill(label: "friday_conversation_id", ref: snapshot.fridayConversationId)
        if let agentSessionId = snapshot.agentSessionId {
          RefPill(label: "agent_session_id", ref: agentSessionId)
        }
        HStack(spacing: 8) {
          Button {
            Task { await viewModel.loadDetail(.sessionList) }
          } label: {
            Label("Sessions", systemImage: "rectangle.stack")
          }
          .disabled(viewModel.detailState.isLoading)
          if let agentSessionId = snapshot.agentSessionId {
            Button {
              Task { await viewModel.loadDetail(.sessionOpen(agentSessionId: agentSessionId)) }
            } label: {
              Label("Open", systemImage: "text.bubble")
            }
            .disabled(viewModel.detailState.isLoading)
            Button {
              Task { await viewModel.loadDetail(.sessionLinkState(agentSessionId: agentSessionId)) }
            } label: {
              Label("Link", systemImage: "link")
            }
            .disabled(viewModel.detailState.isLoading)
          }
        }
        detailResult
      }
    }
    .accessibilityIdentifier("friday.desktop.chat.continuity")
  }

  @ViewBuilder
  private var transcriptCard: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Chat")
          Spacer()
          if !history.isEmpty {
            Button {
              history.removeAll()
              historyStore.save(history)
            } label: {
              Label("Clear", systemImage: "trash")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(HubTheme.textSecondary)
            .accessibilityLabel("Clear desktop chat history")
          }
        }
        if history.isEmpty {
          emptyTranscript
        } else {
          ForEach(history.suffix(10)) { message in
            DesktopChatBubble(message: message)
          }
        }
      }
    }
    .accessibilityIdentifier("friday.desktop.chat.transcript")
  }

  private var emptyTranscript: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Ready for a desktop turn.")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(HubTheme.textPrimary)
      Text("No local chat history yet.")
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private var stateCard: some View {
    switch viewModel.intakeState {
    case .ready:
      EmptyView()
    case .sent:
      GlassPanel {
        HStack(spacing: 10) {
          ProgressView()
          Text("Friday is working...")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(HubTheme.textPrimary)
        }
      }
    case let .confirmed(summary, questions, answerBody):
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          StatusChip(text: "confirmed", bg: HubTheme.chipDoneBG, fg: HubTheme.chipDoneFG)
          let spokenText = answerBodyText(answerBody) ?? summary
          HStack(spacing: 8) {
            Button {
              voice.speak(spokenText)
            } label: {
              Label("Speak", systemImage: "speaker.wave.2.fill")
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Speak Friday desktop answer")
            .accessibilityIdentifier("friday.desktop.chat.voice-output")

            Button {
              voice.stopSpeaking()
            } label: {
              Image(systemName: "speaker.slash.fill")
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Stop speaking Friday desktop answer")
          }
          Text(spokenText)
            .font(.system(size: 13))
            .foregroundStyle(HubTheme.textPrimary)
            .textSelection(.enabled)
          ForEach(questions, id: \.self) { question in
            Text(question)
              .font(.system(size: 12))
              .foregroundStyle(HubTheme.textSecondary)
          }
        }
      }
      .accessibilityIdentifier("friday.desktop.chat.confirmed")
    case let .error(reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          StatusChip(text: "unavailable", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
          Text(reason)
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        }
      }
      .accessibilityIdentifier("friday.desktop.chat.unavailable")
    }
  }

  @ViewBuilder
  private func reviewCard(_ snapshot: WorkbenchSnapshot) -> some View {
    let actionableItems = chatReviewItems()
    let learningCandidates = snapshot.runOutcomeLearningCandidates
    if viewModel.latestChatTurn != nil || !actionableItems.isEmpty || !learningCandidates.isEmpty {
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          HStack {
            cardTitle("Needs Review")
            Spacer()
            if let turn = viewModel.latestChatTurn, !turn.runIds.isEmpty {
              Button {
                Task { await viewModel.loadLatestChatReview() }
              } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
              }
              .buttonStyle(.borderless)
              .disabled(viewModel.chatReviewState.isLoading)
              .accessibilityLabel("Refresh desktop chat review queue")
            }
          }
          if let turn = viewModel.latestChatTurn {
            RefPill(label: "mission_id", ref: turn.missionId)
            ForEach(turn.runIds, id: \.self) { runId in
              RefPill(label: "run_id", ref: runId)
            }
          }
          reviewStateBanner
          ForEach(actionableItems) { item in
            needsMeRow(item)
          }
          ForEach(learningCandidates) { candidate in
            RunOutcomeLearningCandidateRow(
              candidate: candidate,
              state: viewModel.runOutcomeLearningDecisionStates[candidate.id] ?? .ready,
              onConfirm: {
                Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: true) }
              },
              onReject: {
                Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: false) }
              })
          }
          if actionableItems.isEmpty && learningCandidates.isEmpty {
            Text("No approval, memory, or A1 learning rows are currently projected for this turn.")
              .font(.system(size: 12))
              .foregroundStyle(HubTheme.textSecondary)
          }
        }
      }
      .accessibilityIdentifier("friday.desktop.chat.review")
    }
  }

  @ViewBuilder
  private var reviewStateBanner: some View {
    switch viewModel.chatReviewState {
    case .idle:
      EmptyView()
    case .loading:
      HStack(spacing: 8) {
        ProgressView().scaleEffect(0.7)
        Text("Reading activity needs-me rows...")
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
    case .loaded:
      EmptyView()
    case let .unavailable(reason):
      HStack(spacing: 8) {
        StatusChip(text: "unavailable", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
        Text(reason)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
    }
  }

  private func chatReviewItems() -> [ChatNeedsMeItem] {
    guard case let .loaded(items) = viewModel.chatReviewState else { return [] }
    return items
  }

  @ViewBuilder
  private func needsMeRow(_ item: ChatNeedsMeItem) -> some View {
    if item.kind == "memory_review" {
      MemoryCandidateRow(
        candidate: MissionWorkbenchMemoryCandidate(
          id: item.refId,
          preview: item.title,
          state: "candidate_review_only",
          grantsMemoryAuthority: false,
          evidenceRef: item.deepLink ?? item.refId),
        state: viewModel.memoryDecisionStates[item.refId] ?? .ready,
        onConfirm: {
          Task { await viewModel.decideMemory(candidateId: item.refId, memoryId: item.refId, confirm: true) }
        },
        onReject: {
          Task { await viewModel.decideMemory(candidateId: item.refId, memoryId: item.refId, confirm: false) }
        })
    } else {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          StatusChip(text: item.kind, bg: HubTheme.chipPendingBG, fg: HubTheme.chipPendingFG)
          Text(item.state)
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
          Spacer()
        }
        Text(item.title)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textPrimary)
        RefPill(label: "run_id", ref: item.runId)
        RefPill(label: "ref_id", ref: item.refId)
        if let actionDigest = item.actionDigest {
          RefPill(label: "action_digest", ref: actionDigest)
        }
        if let signingSummary = item.signingSummary {
          Text(signingSummary)
            .font(.system(size: 10))
            .foregroundStyle(HubTheme.textSecondary)
            .lineLimit(2)
        }
        if item.kind == "approval_required" {
          HStack(spacing: 8) {
            Button {
              Task { await viewModel.approveNeedsMeItem(item) }
            } label: {
              Label("Approve", systemImage: "checkmark.seal")
            }
            .buttonStyle(.borderedProminent)
            .tint(HubTheme.cyan)
            .disabled(approvalRelayControlsDisabled(for: item))
            .accessibilityLabel("Approve and relay operator signature")
            .accessibilityIdentifier("friday.desktop.chat.approve.\(item.refId)")

            Button {
              Task { await viewModel.rejectNeedsMeApproval(item) }
            } label: {
              Label("Reject", systemImage: "xmark.seal")
            }
            .buttonStyle(.bordered)
            .disabled(approvalRelayControlsDisabled(for: item))
            .accessibilityLabel("Reject pending operator approval")
            .accessibilityIdentifier("friday.desktop.chat.reject.\(item.refId)")

            Button {
              Task { await viewModel.cancelNeedsMeRun(item) }
            } label: {
              Label("Cancel Run", systemImage: "stop.circle")
            }
            .buttonStyle(.bordered)
            .disabled(approvalRelayControlsDisabled(for: item))
            .accessibilityLabel("Cancel paused run")
            .accessibilityIdentifier("friday.desktop.chat.cancelRun.\(item.refId)")

            approvalRelayStatus(for: item)
          }
          Text("Approval remains operator-signature gated; this surface relays an external signer blob and does not mint a signature.")
            .font(.system(size: 10))
            .foregroundStyle(HubTheme.textSecondary)
        } else {
          HStack(spacing: 8) {
            Button {
              Task { await viewModel.markNeedsMeItemDone(item) }
            } label: {
              Label("Done", systemImage: "checkmark.circle")
            }
            .buttonStyle(.bordered)
            .disabled(activityMarkDoneState(for: item).isSent || activityMarkDoneState(for: item).isTerminal)
            .accessibilityLabel("Mark Needs Review row done")
            .accessibilityIdentifier("friday.desktop.chat.markDone.\(item.refId)")
            activityMarkDoneStatus(for: item)
          }
        }
      }
      .padding(.vertical, 6)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Needs review \(item.kind). \(item.title)")
    }
  }

  private func approvalRelayState(for item: ChatNeedsMeItem) -> WriteActionState {
    viewModel.approvalRelayStates[item.id] ?? .ready
  }

  private func approvalRelayControlsDisabled(for item: ChatNeedsMeItem) -> Bool {
    let state = approvalRelayState(for: item)
    return state.isSent || state.isTerminal
  }

  private func activityMarkDoneState(for item: ChatNeedsMeItem) -> WriteActionState {
    viewModel.activityMarkDoneStates[item.id] ?? .ready
  }

  @ViewBuilder
  private func approvalRelayStatus(for item: ChatNeedsMeItem) -> some View {
    switch approvalRelayState(for: item) {
    case .ready:
      EmptyView()
    case .sent:
      ProgressView().scaleEffect(0.7)
    case let .confirmed(summary, _, _):
      Text(summary)
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
        .lineLimit(2)
    case let .error(reason):
      Text(reason)
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
        .lineLimit(2)
    }
  }

  @ViewBuilder
  private func activityMarkDoneStatus(for item: ChatNeedsMeItem) -> some View {
    switch activityMarkDoneState(for: item) {
    case .ready:
      EmptyView()
    case .sent:
      ProgressView().scaleEffect(0.7)
    case let .confirmed(summary, _, _):
      Text(summary)
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
        .lineLimit(2)
    case let .error(reason):
      Text(reason)
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
        .lineLimit(2)
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      Picker("Route", selection: $routePreference) {
        ForEach(MissionRoutePreference.allCases) { preference in
          Text(preference.title).tag(preference)
        }
      }
      .pickerStyle(.segmented)
      .disabled(viewModel.intakeState.isSent)
      .accessibilityLabel("Route preference")
      .accessibilityIdentifier("friday.desktop.chat.route-preference")

      HStack(spacing: 10) {
        Button {
          voice.toggleRecording { transcript in
            Task { @MainActor in
              draft = transcript
            }
          }
        } label: {
          Image(systemName: voice.isRecording ? "stop.circle.fill" : "mic.circle.fill")
            .font(.system(size: 26))
            .foregroundStyle(voice.isRecording ? HubTheme.coral : HubTheme.cyan)
        }
        .buttonStyle(.plain)
        .disabled(viewModel.intakeState.isSent)
        .accessibilityLabel(voice.isRecording ? "Stop desktop voice input" : "Start desktop voice input")
        .accessibilityIdentifier("friday.desktop.chat.voice-input")

        TextField("Ask Friday...", text: $draft, axis: .vertical)
          .textFieldStyle(.plain)
          .font(.system(size: 13))
          .lineLimit(1...4)
          .padding(.horizontal, 12)
          .padding(.vertical, 9)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(Color.black.opacity(0.05)))
          .disabled(viewModel.intakeState.isSent)
          .accessibilityLabel("Message Friday on desktop")
          .accessibilityIdentifier("friday.desktop.chat.composer")

        Button {
          voice.stopRecording()
          sendDraft()
        } label: {
          Image(systemName: "arrow.up.circle.fill")
            .font(.system(size: 28))
            .foregroundStyle(canSend ? HubTheme.cyan : HubTheme.cyan.opacity(0.25))
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Send desktop chat message")
        .accessibilityIdentifier("friday.desktop.chat.send")
      }
      if let status = voice.status {
        Text(status)
          .font(.system(size: 10))
          .foregroundStyle(voice.isRecording ? HubTheme.cyan : HubTheme.textSecondary)
      }
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 12)
    .background(.ultraThinMaterial)
  }

  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !viewModel.intakeState.isSent
  }

  private func sendDraft() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    draft = ""
    append(.user(text))
    Task {
      await viewModel.submitIntake(intent: text, routePreference: routePreference)
      append(DesktopChatMessage.from(
        viewModel.intakeState,
        turn: viewModel.latestChatTurn,
        reviewState: viewModel.chatReviewState))
    }
  }

  @ViewBuilder
  private var detailResult: some View {
    switch viewModel.detailState {
    case .idle:
      EmptyView()
    case let .loading(arm):
      HStack(spacing: 10) {
        ProgressView()
        Text(arm.title)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
    case let .loaded(detail):
      VStack(alignment: .leading, spacing: 6) {
        Text(detail.summary)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textPrimary)
        ForEach(detail.refs.prefix(4), id: \.self) { ref in
          RefPill(label: nil, ref: ref)
        }
      }
    case let .unavailable(title, reason):
      Text("\(title): \(reason)")
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
    }
  }

  private func append(_ message: DesktopChatMessage) {
    history.append(message)
    history = Array(history.suffix(30))
    historyStore.save(history)
  }

  private func cardTitle(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(HubTheme.textPrimary)
  }
}

private struct DesktopChatBubble: View {
  let message: DesktopChatMessage

  var body: some View {
    HStack {
      if message.role == .friday { bubble; Spacer(minLength: 44) } else { Spacer(minLength: 44); bubble }
    }
  }

  private var bubble: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(message.role.title)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(HubTheme.textSecondary)
      Text(message.text)
        .font(.system(size: 13))
        .foregroundStyle(HubTheme.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      ForEach(message.refs) { ref in
        RefPill(label: ref.label, ref: ref.ref)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(message.role == .friday ? HubTheme.cyanSoft : Color.black.opacity(0.05)))
    .frame(maxWidth: 520, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(message.role.title): \(message.text)")
  }
}

private enum DesktopChatRole: String, Codable, Sendable {
  case user
  case friday

  var title: String {
    switch self {
    case .user: return "You"
    case .friday: return "Friday"
    }
  }
}

private struct DesktopChatMessage: Identifiable, Codable, Equatable, Sendable {
  let id: String
  let role: DesktopChatRole
  let text: String
  let refs: [ChatReceiptRef]
  let createdAtMs: Int64

  static func user(_ text: String) -> Self {
    DesktopChatMessage(role: .user, text: text, refs: [])
  }

  static func from(
    _ state: WriteActionState,
    turn: ChatTurnRefs? = nil,
    reviewState: ChatReviewState = .idle
  ) -> Self {
    var refs = turn?.receiptRefs ?? []
    if case let .loaded(items) = reviewState {
      refs.append(contentsOf: items.flatMap(\.receiptRefs))
    }
    refs = uniqueRefs(refs)

    switch state {
    case .ready:
      return DesktopChatMessage(role: .friday, text: "Ready.", refs: [])
    case .sent:
      return DesktopChatMessage(role: .friday, text: "Working.", refs: [])
    case let .confirmed(summary, questions, answerBody):
      let body = answerBodyText(answerBody) ?? summary
      let questionRefs = questions.map { ChatReceiptRef(label: "clarification", ref: $0) }
      return DesktopChatMessage(role: .friday, text: body, refs: uniqueRefs(refs + questionRefs))
    case let .error(reason):
      return DesktopChatMessage(role: .friday, text: reason, refs: refs)
    }
  }

  init(role: DesktopChatRole, text: String, refs: [ChatReceiptRef]) {
    self.id = UUID().uuidString
    self.role = role
    self.text = text
    self.refs = refs
    self.createdAtMs = Int64(Date().timeIntervalSince1970 * 1000)
  }

  private static func uniqueRefs(_ refs: [ChatReceiptRef]) -> [ChatReceiptRef] {
    var seen = Set<String>()
    return refs.filter { seen.insert($0.id).inserted }
  }
}

struct DesktopChatHistoryStore {
  private let defaults: UserDefaults
  private let key: String

  init(
    defaults: UserDefaults = .standard,
    key: String = "friday.desktop.chat.history.v1"
  ) {
    self.defaults = defaults
    self.key = key
  }

  fileprivate func load() -> [DesktopChatMessage] {
    guard let data = defaults.data(forKey: key) else { return [] }
    return (try? JSONDecoder().decode([DesktopChatMessage].self, from: data)) ?? []
  }

  fileprivate func save(_ messages: [DesktopChatMessage]) {
    guard let data = try? JSONEncoder().encode(messages) else { return }
    defaults.set(data, forKey: key)
  }
}

private func answerBodyText(_ answerBody: String?) -> String? {
  guard let trimmed = answerBody?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return nil
  }
  return trimmed
}

#Preview("Friday Chat · loaded") {
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded))
  DesktopChatScreen(viewModel: vm)
    .frame(width: 760, height: 720)
}

@MainActor
private final class DesktopVoiceController: ObservableObject {
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
      status = "Voice input is unavailable on this Mac."
      return
    }
    SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
      AVCaptureDevice.requestAccess(for: .audio) { micAllowed in
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
    status = "Voice input stopped."
  }

  func speak(_ text: String) {
    stopSpeaking()
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
      status = "Voice input is unavailable on this Mac."
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
      self.request = nil
      status = "Voice input failed: \(error.localizedDescription)"
    }
  }
}
