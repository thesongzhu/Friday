import FridayMobileShellCore
import SwiftUI

/// The full-screen, pet-centered Friday Chat read-WRITE surface (locked: the Friday Chat entry
/// is the top-bar 💬; the composer lives HERE, on a separate screen — never as an on-Home card).
///
/// This is the strict S6 needle: the 4-state chat loop over the package's REAL
/// `SealedWSWriteClient` + the `OperatorSigner` relay (driven by `FridayChatViewModel`):
///   compose → send → refs-only answer; mutating → AgentRunPaused → S6 approval card →
///   operator-signs (relay-only) → resumeWithApproval VERBATIM → refs-only receipt; and
///   honest-unavailable when the Rust write server is DARK (the EXPECTED slice-6 state).
///
/// Truth rules (enforced in the view model): INV-1 (no signing key on the app — the phone relays
/// an OPAQUE blob), INV-2 (a mutation executes ONLY via an operator-approved resume), INV-5
/// (every surfaced field is a ref/label/count/fingerprint — never an inline body).
struct FridayChatScreen: View {
  @StateObject private var viewModel: FridayChatViewModel
  /// Whether the S6 pause/approve/resume is enabled (the run-control flag). OFF ⇒ read-only.
  private let runControlEnabled: Bool

  init(session: FridaySession) {
    self.runControlEnabled = session.runControlEnabled
    _viewModel = StateObject(wrappedValue: FridayChatViewModel(
      writeClient: session.writeClient, signer: session.signer))
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

  @ViewBuilder private var phaseCard: some View {
    switch viewModel.phase {
    case .composing:
      placeholder(
        "Ask Friday anything.",
        "Answers are refs-only (a fingerprint + counts). "
          + (runControlEnabled
            ? "A mutating action pauses for your approval (S6)."
            : "Read-only — approvals enable at slice-6."))
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
        }
      }
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
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(.ultraThinMaterial)
  }

  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !viewModel.phase.isBusy && !viewModel.phase.isAwaitingApproval
  }

  // MARK: - Cards (refs-only throughout — INV-5)

  /// The refs-only answer receipt (a fingerprint + counts, never a body).
  private func answerCard(_ r: ChatAnswerReceipt) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          StatusChip(text: r.status.uppercased(), bg: MobileTheme.chipDoneBG, fg: MobileTheme.chipDoneFG)
          Spacer()
          Button("New") { viewModel.newTurn() }.font(.caption).foregroundStyle(MobileTheme.cyan)
        }
        Text("Friday answered").font(.headline).foregroundStyle(MobileTheme.textPrimary)
        Text("answer is delivered refs-only — a fingerprint + counts (the body rides the owner-gated readback)")
          .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        if let sha = r.answerSha256 { RefPill(label: "answer_sha256", ref: short(sha)) }
        if let len = r.answerLen { RefPill(label: "answer_len", ref: "\(len)") }
        if let turns = r.turns { RefPill(label: "turns", ref: "\(turns)") }
        if let tools = r.executedTools { RefPill(label: "executed_tools", ref: "\(tools)") }
      }
    }
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
          Button(role: .destructive) {
            viewModel.reject()
          } label: {
            Label("Reject", systemImage: "xmark").foregroundStyle(MobileTheme.coral)
          }
          .buttonStyle(.bordered)
        }
      }
    }
  }

  /// The refs-only resume receipt (accepted ⇒ executed; refused ⇒ a successful relay of a refusal).
  private func resumeCard(_ r: ChatResumeReceipt) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          StatusChip(
            text: r.accepted ? "EXECUTED" : "REFUSED",
            bg: r.accepted ? MobileTheme.chipDoneBG : MobileTheme.chipWarnBG,
            fg: r.accepted ? MobileTheme.chipDoneFG : MobileTheme.chipWarnFG)
          Spacer()
          Button("New") { viewModel.newTurn() }.font(.caption).foregroundStyle(MobileTheme.cyan)
        }
        Text(r.accepted ? "Approved action executed" : "Action refused")
          .font(.headline).foregroundStyle(MobileTheme.textPrimary)
        RefPill(label: "op", ref: r.op)
        RefPill(label: "status", ref: r.status)
        if let audit = r.auditRef { RefPill(label: "audit_ref", ref: audit) }
        Text(r.accepted ? "receipt is refs-only — no body" : "the action did NOT execute")
          .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
      }
    }
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
}

#if DEBUG
#Preview("Friday Chat · live write client (dark ⇒ honest-unavailable)") {
  NavigationStack { FridayChatScreen(session: FridaySession()) }
}
#endif
