import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - Device-keypair identity tests (hermetic, CI-safe)
//
// The CLIENT half of the J2/I4 mobile read-seam. These prove the device keypair store's LOGIC and
// the `makeLive(deviceKeypair:)` overload's honest-unavailable behavior WITHOUT touching a real
// Keychain or a live server. The store's persistence sits behind `DeviceKeypairBackend`, so we
// inject an in-memory backend (the real iOS Keychain requires a code-signed app / entitlement and is
// operator-gated on-device — exercising it here on the unsigned `swift test` host would fail with
// `errSecMissingEntitlement` / prompt / pollute the login keychain). This mirrors the codebase's own
// `environment:`/`homeDirectory:` injection in `MasterKeyPeer`.
//
// SECRET DISCIPLINE: only the PUBLIC key hex is asserted/printed. The in-memory backend holds the raw
// scalar for the test's lifetime only and is never logged.

/// An in-memory `DeviceKeypairBackend` for hermetic tests — holds the raw secret in a box, never a
/// keychain. Thread-safety is irrelevant here (single-threaded test use), but it is `@unchecked
/// Sendable` to satisfy the protocol's `Sendable` requirement.
private final class InMemoryDeviceKeypairBackend: DeviceKeypairBackend, @unchecked Sendable {
  private var secret: [UInt8]?
  /// Count of `storeSecret` calls — lets a test assert generation happened exactly once.
  private(set) var storeCount = 0

  /// Optionally seed a pre-existing stored secret (e.g. a wrong-length corrupt item).
  init(seed: [UInt8]? = nil) { self.secret = seed }

  func loadSecret() throws -> [UInt8]? { secret }
  func storeSecret(_ secret: [UInt8]) throws {
    self.secret = secret
    storeCount += 1
  }
}

@Test
func deviceKeypairGeneratePersistReloadIsStable() throws {
  // FIRST call generates + persists; the SECOND reuses the SAME persisted secret → SAME pubkey.
  // This is the format-level crypto-match proof: the reconstructed keypair flows through the shared,
  // KAT-proven `FridayCrypto.DeviceKeypair(secretBytes:)`, and a stable pubkey is what makes a ONE-
  // TIME `hub_read_seam_enroll --pubkey <hex> --add` valid across app launches.
  let backend = InMemoryDeviceKeypairBackend()

  let first = try DeviceKeypairStore.loadOrGenerate(backend: backend)
  #expect(backend.storeCount == 1)  // generated once

  let second = try DeviceKeypairStore.loadOrGenerate(backend: backend)
  #expect(backend.storeCount == 1)  // reused — NOT regenerated

  #expect(first.publicKeyHex == second.publicKeyHex)
  #expect(first.keypair.publicKey == second.keypair.publicKey)
}

@Test
func deviceKeypairPublicKeyHexIs64Hex() throws {
  // The value the operator passes to `hub_read_seam_enroll --pubkey <64-hex> --add`: a 32-byte X25519
  // public key, lowercase-hex, no `0x` — so it must be exactly 64 hex chars.
  let kp = try DeviceKeypairStore.loadOrGenerate(backend: InMemoryDeviceKeypairBackend())
  let hex = kp.publicKeyHex
  #expect(hex.count == 64)
  #expect(hex.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) })
  // And it round-trips back to the 32 raw public-key bytes via the shared Hex decoder.
  let decoded = try Hex.decode(hex)
  #expect(decoded == kp.keypair.publicKey)
  #expect(decoded.count == FridayCrypto.x25519SecretLen)
}

@Test
func deviceKeypairDistinctInstancesGenerateDistinctIdentities() throws {
  // Two FRESH stores (separate backends) generate independent identities — the keygen is the
  // CryptoKit CSPRNG, so collisions are effectively impossible. (Guards against an accidental
  // hard-coded/constant secret.)
  let a = try DeviceKeypairStore.loadOrGenerate(backend: InMemoryDeviceKeypairBackend())
  let b = try DeviceKeypairStore.loadOrGenerate(backend: InMemoryDeviceKeypairBackend())
  #expect(a.publicKeyHex != b.publicKeyHex)
}

@Test
func deviceKeypairWrongLengthStoredSecretFailsClosed() {
  // A corrupt / foreign keychain item (wrong byte width) fails closed — it is NEVER silently
  // truncated/padded or regenerated over (which would change the identity and invalidate a prior
  // enrollment without the operator noticing).
  let backend = InMemoryDeviceKeypairBackend(seed: [UInt8](repeating: 0x42, count: 16))
  #expect(throws: DeviceKeypairStoreError.self) {
    _ = try DeviceKeypairStore.loadOrGenerate(backend: backend)
  }
}

@Test
func makeLiveWithDeviceKeypairBuildsClientAndIsHonestlyUnavailableWithNoServer() async throws {
  // The `makeLive(deviceKeypair:)` overload builds a real-protocol client; against a DARK server
  // (here: a dead loopback port with a short connect timeout) it surfaces honest-unavailable —
  // a `FridayReadClientError`, never a silent mock / fabricated ready snapshot.
  let device = try DeviceKeypairStore.loadOrGenerate(backend: InMemoryDeviceKeypairBackend())

  // A dead high port + short timeout: fast + avoids colliding with a dev running the real server
  // on 48751. Nothing listens here, so the transport fails the connect → honest unavailable.
  let deadConfig = ReadProjectionServerConfig(host: "127.0.0.1", port: 59999, connectTimeout: 1)
  let client = RealReadClientFactory.makeLive(deviceKeypair: device, config: deadConfig)

  do {
    _ = try await client.fetchWorkbench()
    Issue.record("a dark server must NOT yield a successful read")
  } catch is FridayReadClientError {
    // Expected: honest-unavailable (connect/handshake failed) — not a mock, not a crash.
  }
}
