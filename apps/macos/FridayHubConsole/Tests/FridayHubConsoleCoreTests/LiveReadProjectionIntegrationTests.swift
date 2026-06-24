import Foundation
import Testing

@testable import FridayHubConsoleCore
@testable import FridayRustClient

// MARK: - LIVE read-projection integration (MANUAL / env-gated — CI SKIPS)
//
// These tests drive the REAL `SealedWSReadClient` + `LoopbackSealedWSTransport` against a RUNNING
// `hub_read_projection_server` on 127.0.0.1:48751, deriving the enrolled MASTER-DERIVED peer from
// the host `~/.friday/master.key`. They read a real host secret and require a live server, so
// they are GATED on `FRIDAY_CONSOLE_LIVE_TEST=1` and are SKIPPED in CI (which has no such server
// and must never read the host master key).
//
// Run locally:
//   FRIDAY_CONSOLE_LIVE_TEST=1 swift test --package-path apps/macos/FridayHubConsole \
//     --filter Live
//
// Optional scratch-port + T3 assertion:
//   FRIDAY_CONSOLE_LIVE_TEST=1 \
//   FRIDAY_CONSOLE_LIVE_READ_PORT=59152 \
//   FRIDAY_CONSOLE_EXPECT_T3_READY=1 \
//   swift test --package-path apps/macos/FridayHubConsole --filter LiveReadProjection
//
// PROOF CEILING (honest): the live read-projection DB may have NO active mission, in which case
// the server returns a TYPED `Error(HUB_OFFLINE, "no active mission found")` rather than a
// snapshot. That typed response is itself the end-to-end proof: it is owner-sealed under the
// session key and emitted ONLY AFTER the full handshake + master-derived peer-allowlist auth +
// owner (`admin-001`) auth pass. A forged / non-enrolled peer (the negative control) instead has
// its session ENDED with no response. We assert BOTH outcomes.
//
// SECRET DISCIPLINE: we print the public key hex + the decoded typed response fields only —
// never the master key or any derived secret.

private let liveTestEnabled = ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_TEST"] == "1"
private let expectT3Ready = ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_EXPECT_T3_READY"] == "1"

@Test(.enabled(if: liveTestEnabled))
func liveReadProjectionSealedRoundTripWithMasterDerivedPeer() async throws {
  // The enrolled peer: derive the keypair from the host master key the SAME way the enroll CLI
  // did. Its pubkey is the allowlisted reader (offline-proven by masterDerivedPubkeyMatchesRustKat
  // against the KAT; here it is the REAL host key).
  let keypair = try MasterKeyPeer.deriveKeypair()
  print("[live] master-derived peer pubkey (PUBLIC) = \(Hex.encode(keypair.publicKey))")

  // Use the EXACT path the app launches under FRIDAY_CONSOLE_LIVE=1: `makeLive()` derives the
  // master-derived peer and authenticates as `admin-001` (the LaunchAgent owner). Tests may
  // target a scratch read-projection server by setting FRIDAY_CONSOLE_LIVE_READ_HOST/PORT; this
  // keeps the product default on 48751 while allowing no-prod-kill live proofs.
  let config = liveReadConfigFromEnvironment()
  let client = try RealReadClientFactory.makeLive(config: config)
  print("[live] desktop read target = \(config.host):\(config.port)")

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
    if expectT3Ready {
      let displaySnapshot = try WorkbenchSnapshotAdapter.display(from: snapshot)
      let t3 = try #require(displaySnapshot.t3ProvisioningStatus)
      #expect(t3.isFullyProvisioned)
      #expect(t3.activeTrustedDeviceCount > 0)
      #expect(t3.activeTrustGrantCount > 0)
      #expect(t3.contextPassportCount > 0)
      #expect(t3.contextPassportItemCount > 0)
      print(
        "[live] T3 READY desktop projection decoded: "
          + "activeTrustedDeviceCount=\(t3.activeTrustedDeviceCount) "
          + "activeTrustGrantCount=\(t3.activeTrustGrantCount) "
          + "contextPassportCount=\(t3.contextPassportCount) "
          + "contextPassportItemCount=\(t3.contextPassportItemCount)")
    }
  } catch let FridayReadClientError.serverError(code, message) {
    // The EXPECTED ceiling against an empty live DB: a typed, owner-sealed Error we could only
    // open because the full handshake + peer-auth + owner-auth round-trip SUCCEEDED.
    print("[live] AUTHENTICATED ROUND-TRIP OK — typed server response: code=\(code) message=\(message)")
    if expectT3Ready {
      Issue.record("expected a T3-ready desktop snapshot, got typed server response: \(code) \(message)")
    }
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
    makeTransport: { try LoopbackSealedWSTransport(config: liveReadConfigFromEnvironment()) })

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

private func liveReadConfigFromEnvironment() -> ReadProjectionServerConfig {
  let env = ProcessInfo.processInfo.environment
  let host = env["FRIDAY_CONSOLE_LIVE_READ_HOST"] ?? ReadProjectionServerConfig.liveLoopback.host
  let port = env["FRIDAY_CONSOLE_LIVE_READ_PORT"].flatMap(UInt16.init)
    ?? ReadProjectionServerConfig.liveLoopback.port
  return ReadProjectionServerConfig(host: host, port: port)
}
