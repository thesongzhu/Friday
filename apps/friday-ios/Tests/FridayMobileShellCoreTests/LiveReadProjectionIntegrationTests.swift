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
// To target an isolated scratch read server (leaving production :48751 untouched), pass:
//   FRIDAY_MOBILE_LIVE_READ_PORT=59151
//
// To assert that the live projection includes an operator-provisioned T3 grant/passport:
//   FRIDAY_MOBILE_EXPECT_T3_READY=1
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
  // master-derived peer, targets the live read server, and authenticates as `admin-001` (the
  // LaunchAgent owner). The optional env override mirrors the app's live-loopback proof path so
  // tests can target a scratch read server without touching production :48751.
  let client = try RealReadClientFactory.makeLive(config: liveReadTestConfig())

  // Drive the full handshake → owner-authed request → open the owner-sealed reply.
  do {
    let snapshot = try await client.fetchWorkbench()
    let projection = HomeProjection(snapshot)
    // A real snapshot DID decode — print its refs-only fields as the live-render proof.
    print(
      "[live] DECODED SNAPSHOT missionId=\(snapshot.missionId) "
        + "runtimeFeedStatus=\(snapshot.runtimeFeedStatus) "
        + "statusLabels=\(snapshot.statusLabels) workItemIds=\(snapshot.workItemIds) "
        + "generatedAtMs=\(snapshot.generatedAtMs)")
    #expect(!snapshot.missionId.isEmpty)
    if ProcessInfo.processInfo.environment["FRIDAY_MOBILE_EXPECT_T3_READY"] == "1" {
      let t3 = try #require(projection.t3ProvisioningStatus)
      #expect(t3.isFullyProvisioned)
      #expect(t3.activeTrustedDeviceCount > 0)
      #expect(t3.activeTrustGrantCount > 0)
      #expect(t3.contextPassportCount > 0)
      #expect(t3.contextPassportItemCount > 0)
      print("[live] T3 READY projection decoded: \(t3.homeSummary)")
    }
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
func liveDeviceKeypairPathDrivesServerAndIsRefusedUntilEnrolled() async throws {
  // The DEVICE path (J2/I4 client half) against the LIVE server. HONEST SCOPE: this uses an
  // in-memory backend (the real Keychain is operator-gated on-device), so it mints a FRESH random
  // device key each run that is discarded — therefore this peer is NEVER in the allowlist and this
  // test can ONLY exercise connect → handshake → fail-closed-refuse (the un-paired state). It proves
  // `makeLive(deviceKeypair:)` drives the SAME live transport as the master path and is refused
  // honestly (NOT a mock) for a non-enrolled peer. It does NOT — and structurally cannot — prove an
  // enrolled device round-trip: that needs the STABLE on-device Keychain key + the operator running
  // `hub_read_seam_enroll --pubkey <that device's hex> --add`, which is the physical-device step.
  let device = try DeviceKeypairStore.loadOrGenerate(backend: InMemoryLiveDeviceBackend())
  print("[live] DEVICE (ephemeral, host-test) peer pubkey = \(device.publicKeyHex) "
    + "(on a real device, enroll the STABLE Keychain pubkey via "
    + "hub_read_seam_enroll --pubkey <hex> --add)")

  let client = RealReadClientFactory.makeLive(deviceKeypair: device, config: liveReadTestConfig())
  do {
    _ = try await client.fetchWorkbench()
    Issue.record("a non-enrolled device peer must NOT get a successful read")
  } catch let FridayReadClientError.serverError(code, message) {
    Issue.record("non-enrolled device peer unexpectedly authenticated: \(code) \(message)")
  } catch {
    // Expected: the fresh (non-enrolled) device peer is refused / session-ended fail-closed.
    print("[live] non-enrolled device peer REFUSED (fail-closed) as expected: \(error)")
  }
}

/// In-memory backend for the live device test (the real Keychain is operator-gated on-device). Empty
/// at start, so `loadOrGenerate` mints a fresh ephemeral key per run — this host test proves the
/// CLIENT transport path + honest refuse, NOT the device Keychain persistence or an enrolled
/// round-trip (those are the on-device + operator step).
private final class InMemoryLiveDeviceBackend: DeviceKeypairBackend, @unchecked Sendable {
  private var secret: [UInt8]?
  func loadSecret() throws -> [UInt8]? { secret }
  func storeSecret(_ secret: [UInt8]) throws { self.secret = secret }
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
    makeTransport: { try LoopbackSealedWSTransport(config: liveReadTestConfig()) })

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

private func liveReadTestConfig() -> ReadProjectionServerConfig {
  let env = ProcessInfo.processInfo.environment
  let host = env["FRIDAY_MOBILE_LIVE_READ_HOST"].flatMap { $0.isEmpty ? nil : $0 } ?? "127.0.0.1"
  let port = env["FRIDAY_MOBILE_LIVE_READ_PORT"].flatMap(UInt16.init) ?? 48751
  return ReadProjectionServerConfig(host: host, port: port)
}
