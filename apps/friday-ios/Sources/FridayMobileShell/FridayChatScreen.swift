import FridayMobileShellCore
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
  /// Whether the S6 pause/approve/resume is enabled (the run-control flag). OFF ⇒ read-only.
  private let runControlEnabled: Bool

  init(session: FridaySession) {
    self.runControlEnabled = session.runControlEnabled
    _viewModel = StateObject(wrappedValue: FridayChatViewModel(
      writeClient: session.writeClient,
      signer: session.signer,
      missionClient: session.missionClient,
      readClient: session.readClient))
  }

  @State private var draft = ""

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
              if let runId = item.runId {
                RefPill(label: "run_id", ref: short(runId))
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
            Text("Unavailable").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          }
          Text(reason).font(.caption2).foregroundStyle(MobileTheme.textSecondary)
          Button("Start over") { viewModel.newTurn() }
            .font(.caption).foregroundStyle(MobileTheme.cyan)
            .accessibilityLabel("Start a new Friday chat turn")
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Friday unavailable. \(reason)")
      .accessibilityIdentifier("friday.chat.unavailable")
    }
  }

  // MARK: - Composer (Compose → Send)

  private var composer: some View {
    HStack(spacing: 10) {
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
        let task = draft
        draft = ""
        Task { await viewModel.send(task) }
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 30))
          .foregroundStyle(canSend ? MobileTheme.cyan : MobileTheme.cyan.opacity(0.25))
      }
      .disabled(!canSend)
      .accessibilityLabel("Send message to Friday")
      .accessibilityIdentifier("friday.chat.send")
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
          StatusChip(text: r.status.uppercased(), bg: MobileTheme.chipDoneBG, fg: MobileTheme.chipDoneFG)
          Spacer()
          Button("New") { viewModel.newTurn() }.font(.caption).foregroundStyle(MobileTheme.cyan)
        }
        Text("Friday answered").font(.headline).foregroundStyle(MobileTheme.textPrimary)
        if let answer = readableAnswer(r.answerBody) {
          Text(answer)
            .font(.body)
            .foregroundStyle(MobileTheme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
          if let runId = r.answerBodyRunId {
            RefPill(label: "answer_body_run_id", ref: runId)
          }
        } else {
          Text("Answer body is not available from the owner-gated readback yet.")
            .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        }
        if let sha = r.answerSha256 { RefPill(label: "answer_sha256", ref: short(sha)) }
        if let missionId = r.missionId { RefPill(label: "mission_id", ref: missionId) }
        if let workItemId = r.workItemId { RefPill(label: "work_item_id", ref: workItemId) }
        if let followUpWorkItemId = r.followUpWorkItemId {
          RefPill(label: "follow_up_work_item_id", ref: followUpWorkItemId)
        }
        if let followUpRunId = r.followUpRunId { RefPill(label: "follow_up_run_id", ref: followUpRunId) }
        if let len = r.answerLen { RefPill(label: "answer_len", ref: "\(len)") }
        if let outcome = r.answerBodyOutcome { RefPill(label: "answer_body", ref: outcome) }
        if let turns = r.turns { RefPill(label: "turns", ref: "\(turns)") }
        if let tools = r.executedTools { RefPill(label: "executed_tools", ref: "\(tools)") }
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
          StatusChip(text: card.truthLabel, bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
        }
        // SUMMARY (what paused) — a coarse verb + the owner-sealed summary.
        Text(card.actionVerb).font(.title3).bold().foregroundStyle(MobileTheme.textPrimary)
        if let summary = card.ownerSealedSummary {
          Text(summary).font(.callout).foregroundStyle(MobileTheme.textPrimary)
        }
        // PROOF (the digest the operator signs over) — never a body.
        RefPill(label: "action_digest", ref: short(card.actionDigest))
        RefPill(label: "approval_id", ref: card.approvalId)
        Text("Friday paused this mutating action. Approving asks the operator signer for a "
          + "signature; the phone relays it but never signs (INV-1).")
          .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        HStack(spacing: 12) {
          Button {
            Task { await viewModel.approve() }
          } label: {
            Label("Approve", systemImage: "checkmark.seal").bold()
          }
          .buttonStyle(.borderedProminent).tint(MobileTheme.cyan)
          .accessibilityLabel("Approve Friday action")
          Button(role: .destructive) {
            Task { await viewModel.reject() }
          } label: {
            Label("Reject", systemImage: "xmark").foregroundStyle(MobileTheme.coral)
          }
          .buttonStyle(.bordered)
          .accessibilityLabel("Reject Friday action")
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
          StatusChip(
            text: r.statusLabel,
            bg: r.accepted ? MobileTheme.chipDoneBG : MobileTheme.chipWarnBG,
            fg: r.accepted ? MobileTheme.chipDoneFG : MobileTheme.chipWarnFG)
          Spacer()
          Button("New") { viewModel.newTurn() }.font(.caption).foregroundStyle(MobileTheme.cyan)
        }
        Text(r.title)
          .font(.headline).foregroundStyle(MobileTheme.textPrimary)
        RefPill(label: "op", ref: r.op)
        RefPill(label: "status", ref: r.status)
        if let audit = r.auditRef { RefPill(label: "audit_ref", ref: audit) }
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
}

#if DEBUG
#Preview("Friday Chat · live write client (dark ⇒ honest-unavailable)") {
  NavigationStack { FridayChatScreen(session: FridaySession()) }
}
#endif
