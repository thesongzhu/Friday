import Foundation

/// View model for the full-screen, pet-centered Friday Chat surface.
///
/// M-PR1 SCOPE: this is a SKELETON only. The chat read-WRITE loop and the S6
/// approval flow are a LATER slice. Per the M-PR1 truth contract this surface:
///  - has NO send/dispatch path (the composer is inert in this slice),
///  - performs NO mutating action and makes NO model/provider call,
///  - is honest about being not-yet-wired (the view shows that plainly).
///
/// It is intentionally tiny so the shell, the top-bar 💬 entry, and the
/// pet-centered layout can be reviewed without faking a working chat.
@MainActor
public final class ChatViewModel: ObservableObject {
  /// The composer draft. Local-only echo; there is no send in M-PR1.
  @Published public var draft: String = ""

  /// Whether the (later-slice) send path is wired. Always false in M-PR1 — the UI
  /// reads this to render the composer as honestly inert, never as a live send.
  public let sendEnabled: Bool = false

  public init() {}

  /// Honest copy describing why the composer is inert in this slice. Surfaced AS
  /// truth in the chat surface — never a fake "ready to chat" state.
  public var skeletonNotice: String {
    "Friday Chat is a shell in this build — the live chat loop and approval flow "
      + "arrive in a later slice. Nothing is sent yet."
  }
}
