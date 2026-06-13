import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE read-projection integration (MANUAL / env-gated — CI SKIPS)
//
// PORTED from the desktop `FridayHubConsoleCoreTests/LiveReadProjectionIntegrationTests.swift`
// (#686). These tests drive the REAL `SealedWSReadClient` + the iOS `LoopbackSealedWSTransport`
// against a RUNNING `hub_read_projection_server` on 127.0.0.1:48751, deriving the enrolled
// MASTER-DERIVED peer from the host `~/.friday/master.key` (the SAME peer the desktop derives).
// They read a real host secret and require a live server, so they are GATED on
// `FRIDAY_MOBILE_LIVE_READ_TEST=1` and are SKIPPED in CI (which has no such server and must never
// read the host master key).
//
// Run locally (the read-projection server must already be listening — verify with
// `lsof -nP -iTCP:48751 -sTCP:LISTEN`):
//   FRIDAY_MOBILE_LIVE_READ_TEST=1 swift test --package-path apps/friday-ios \
//     --filter LiveReadProjection
//
// PROOF CEILING (honest): the live read-projection DB may have NO active mission, in which case
// the server returns a TYPED `Error(HUB_OFFLINE, "no active mission found")` rather than a
// snapshot. That typed response is itself the end-to-end proof: it is owner-sealed under the
// session key and emitted ONLY AFTER the full handshake + master-derived peer-allowlist auth +
// owner (`admin-001`) auth pass. A forged / non-enrolled peer (the negative control) instead has
// its session ENDED with no response. We assert BOTH outcomes. This proves the e2e sealed
// round-trip, NOT a rich populated render (the read DB is sparse).
//
// SINGLE-PEER-TRAP NOTE: the master-derived path NEVER enrolls a fresh key — it only reads the
// master key and derives in memory; the negative-control's `FridayCrypto.DeviceKeypair()` is an
// in-memory ephemeral key that opens a socket but writes NOTHING to the shared SecureStore.
//
// SECRET DISCIPLINE: we print the public key hex + the decoded typed response fields only —
// never the master key or any derived secret.

private let liveTestEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_READ_TEST"] == "1"

@Test(.enabled(if: liveTestEnabled))
func liveReadProjectionSealedRoundTripWithMasterDerivedPeer() async throws {
  // The enrolled peer: derive the keypair from the host master key the SAME way the enroll CLI
  // did. Its pubkey is the allowlisted reader (offline-proven by masterDerivedPubkeyMatchesRustKat
  // against the KAT; here it is the REAL host key).
  let keypair = try MasterKeyPeer.deriveKeypair()
  print("[live] master-derived peer pubkey (PUBLIC) = \(Hex.encode(keypair.publicKey))")

  // Use the EXACT path the app launches under FRIDAY_MOBILE_LIVE_READ=1: `makeLive()` derives the
  // master-derived peer, targets 48751, and authenticates as `admin-001` (the LaunchAgent owner).
  let client = try RealReadClientFactory.makeLive()

  // Drive the full handshake → owner-authed request → open the owner-sealed reply.
  do {
    let snapshot = try await client.fetchWorkbench()
    // A real snapshot DID decode — print its refs-only fields as the live-render proof.
    print(
      "[live] DECODED SNAPSHOT missionId=\(snapshot.missionId) "
        + "runtimeFeedStatus=\(snapshot.runtimeFeedStatus) "
        + "statusLabels=\(snapshot.statusLabels) workItemIds=\(snapshot.workItemIds) "
        + "generatedAtMs=\(snapshot.generatedAtMs)")
    #expect(!snapshot.missionId.isEmpty)
  } catch let FridayReadClientError.serverError(code, message) {
    // The EXPECTED ceiling against an empty live DB: a typed, owner-sealed Error we could only
    // open because the full handshake + peer-auth + owner-auth round-trip SUCCEEDED.
    print("[live] AUTHENTICATED ROUND-TRIP OK — typed server response: code=\(code) message=\(message)")
    #expect(code == .hubOffline || code == .internal)
  }
  // Any OTHER error (transport/handshake/badServerPubkey/...) propagates and FAILS the test —
  // that would mean the live round-trip did not complete; we do not swallow it.
}

@Test(.enabled(if: liveTestEnabled))
func liveReadProjectionRefusesFreshEphemeralPeer() async throws {
  // NEGATIVE CONTROL — proves the master-derivation is load-bearing. A FRESH ephemeral keypair is
  // NOT the enrolled allowlist peer, so the server refuses it: the session ends with no owner-
  // sealed response (the read server fail-closes on a non-allowlisted peer). The client surfaces
  // that as a transport error — DISTINCT from the master-derived peer's authenticated response.
  let ephemeral = FridayCrypto.DeviceKeypair()
  print("[live] ephemeral (NON-enrolled) pubkey = \(Hex.encode(ephemeral.publicKey))")

  let client = SealedWSReadClient(
    keypair: ephemeral,
    forwardedPrincipal: liveReadProjectionOwnerPrincipal,
    makeTransport: { try LoopbackSealedWSTransport(config: .liveLoopback) })

  do {
    _ = try await client.fetchWorkbench()
    Issue.record("a non-enrolled ephemeral peer must NOT get a successful read")
  } catch let FridayReadClientError.serverError(code, message) {
    Issue.record("ephemeral peer unexpectedly authenticated: \(code) \(message)")
  } catch {
    // The expected outcome: refused / session-ended / transport failure. Print it as evidence.
    print("[live] ephemeral peer REFUSED (fail-closed) as expected: \(error)")
  }
}
