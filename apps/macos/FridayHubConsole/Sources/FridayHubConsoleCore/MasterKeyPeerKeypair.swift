import CryptoKit
import Foundation
import FridayRustClient

// MARK: - Master-derived peer keypair (the enrolled read-seam allowlist peer)
//
// The live read-projection server (`hub_read_projection_server`) refuses any peer whose X25519
// public key is not in the SecureStore peer-allowlist (`PEER_PUBKEY_ALLOWLIST_ID`). The slice-6
// enroll CLI (`hub_read_seam_enroll --from-master`, the DEFAULT) enrolls EXACTLY the
// master-derived desktop peer pubkey — the SAME value the Rust
// `friday_hub::key_source::derive_client_x25519_pubkey(master)` produces. So the desktop Console,
// to be the enrolled reader, MUST derive its keypair from the host master key the IDENTICAL way.
//
// DERIVATION (byte-exact parity with Rust `key_source::derive_client_x25519_secret` + the TS
// `resolveRustAgentRunWsClientX25519Secret`):
//
//   secret_scalar = SHA256( WS_X25519_SECRET_PURPOSE_utf8 ‖ master_key_32 )   // purpose FIRST
//   keypair       = DeviceKeypair(secretBytes: secret_scalar)                 // X25519, clamped
//
// The X25519 secret→public step then reuses `FridayCrypto.DeviceKeypair` (CryptoKit Curve25519),
// already proven byte-identical to Rust `x25519-dalek` `from_secret_bytes` by the package KAT
// `testK1_pubkeyByteIdenticalToRust`. The full master→pubkey chain is asserted offline by
// `masterDerivedPubkeyMatchesRustKat` (the Rust `key_source` cross-language KAT vector).
//
// MASTER-KEY SOURCE (mirrors Rust `key_source::read_master_key`, which itself mirrors the TS
// `getMasterKey` source order MINUS auto-gen — never auto-generate here):
//   (1) `FRIDAY_MASTER_KEY` env (hex), highest priority; else
//   (2) `~/.friday/master.key` (file bytes → UTF-8 → `trim()` → hex-decode), MUST be 32 bytes.
// A missing/invalid master key is a typed error — NEVER auto-generated, NEVER defaulted.
//
// SECRET DISCIPLINE: the master key and the derived secret scalar live only in locals that go out
// of scope at once; NOTHING in this file logs/prints/embeds either. Only the PUBLIC key is exposed
// (public by construction), and the error vocabulary names a failure CATEGORY, never a value.

public enum MasterKeyPeerError: Error, Equatable, CustomStringConvertible {
  /// `$HOME` is unset, so `~/.friday/master.key` cannot be located (and no env override).
  case homeUnavailable
  /// Neither `FRIDAY_MASTER_KEY` nor `~/.friday/master.key` is present. FAIL CLOSED — this
  /// type NEVER auto-generates a master key (the host's TS layer owns auto-gen; a self-minted
  /// key would derive a DIFFERENT pubkey that is not the enrolled allowlist peer).
  case masterKeyMissing
  /// The env var / file content was not valid hex (the master key is hex-encoded in both).
  case masterKeyNotHex
  /// The decoded master key was the wrong length. Reports the OBSERVED length only.
  case masterKeyWrongLength(Int)
  /// The master key file exists but could not be read (IO error other than not-found).
  case masterKeyUnreadable

  public var description: String {
    switch self {
    case .homeUnavailable: return "HOME is not set; cannot locate ~/.friday/master.key"
    case .masterKeyMissing:
      return "no master key: set FRIDAY_MASTER_KEY (hex) or provision ~/.friday/master.key"
    case .masterKeyNotHex: return "master key is not valid hex"
    case let .masterKeyWrongLength(n): return "master key must be 32 bytes, got \(n)"
    case .masterKeyUnreadable: return "master key file is unreadable"
    }
  }
}

public enum MasterKeyPeer {
  /// Master-key width (bytes). Mirrors Rust `key_source::MASTER_KEY_LEN` / TS `KEY_BYTES`.
  public static let masterKeyLen = 32

  /// Env var carrying the hex master key (highest-priority source). Mirrors Rust
  /// `MASTER_KEY_ENV` / the TS `FRIDAY_MASTER_KEY`.
  static let masterKeyEnv = "FRIDAY_MASTER_KEY"

  /// `~/.friday/master.key`, relative to `$HOME`. Mirrors Rust `MASTER_KEY_FILE_REL`.
  static let masterKeyFileRel = ".friday/master.key"

  /// Domain-separation tag for the client X25519 SECRET derivation. BYTE-EXACT with Rust
  /// `key_source::WS_X25519_SECRET_PURPOSE` and the TS `WS_X25519_SECRET_PURPOSE`. The purpose
  /// is hashed FIRST, then the master key.
  static let wsX25519SecretPurpose = Array("friday.rust.agent_run.ws.x25519_secret.v1".utf8)

  /// Read the 32-byte master key fail-closed, mirroring Rust `read_master_key`:
  /// `FRIDAY_MASTER_KEY` (hex) if set, else `~/.friday/master.key` (UTF-8 → trim → hex).
  /// Never auto-generates. Returns the raw 32 bytes (the caller derives + drops them promptly).
  static func readMasterKey(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) throws -> [UInt8] {
    // (1) FRIDAY_MASTER_KEY env (hex).
    if let envHex = environment[masterKeyEnv], !envHex.isEmpty {
      return try decodeMasterHex(envHex)
    }
    // (2) ~/.friday/master.key (hex). A not-found file falls through to .masterKeyMissing.
    let fileURL = homeDirectory.appendingPathComponent(masterKeyFileRel)
    guard FileManager.default.fileExists(atPath: fileURL.path) else {
      throw MasterKeyPeerError.masterKeyMissing
    }
    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch {
      throw MasterKeyPeerError.masterKeyUnreadable
    }
    guard let text = String(data: data, encoding: .utf8) else {
      throw MasterKeyPeerError.masterKeyNotHex
    }
    return try decodeMasterHex(text.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  private static func decodeMasterHex(_ hex: String) throws -> [UInt8] {
    let bytes: [UInt8]
    do {
      bytes = try Hex.decode(hex)
    } catch {
      throw MasterKeyPeerError.masterKeyNotHex
    }
    guard bytes.count == masterKeyLen else {
      throw MasterKeyPeerError.masterKeyWrongLength(bytes.count)
    }
    return bytes
  }

  /// Derive the X25519 secret scalar from the master key:
  /// `SHA256(WS_X25519_SECRET_PURPOSE ‖ master)` (purpose first). Byte-exact with Rust
  /// `key_source::derive_client_x25519_secret`. The secret is returned as a value the caller
  /// immediately feeds to `DeviceKeypair(secretBytes:)`; it is never logged.
  static func deriveSecretScalar(master: [UInt8]) -> [UInt8] {
    var hasher = SHA256()
    hasher.update(data: Data(wsX25519SecretPurpose))
    hasher.update(data: Data(master))
    return Array(hasher.finalize())
  }

  /// Build the master-derived peer keypair — the enrolled read-seam allowlist peer.
  ///
  /// Reads the master key (env or `~/.friday/master.key`), derives the X25519 secret, and
  /// constructs a `FridayCrypto.DeviceKeypair`. Its `.publicKey` equals the enrolled allowlist
  /// entry (proven offline by the master→pubkey KAT), so the live handshake is accepted.
  /// Throws (fail-closed) if the master key is missing/invalid — NEVER auto-generates a key.
  public static func deriveKeypair(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) throws -> FridayCrypto.DeviceKeypair {
    let master = try readMasterKey(environment: environment, homeDirectory: homeDirectory)
    let secret = deriveSecretScalar(master: master)
    do {
      return try FridayCrypto.DeviceKeypair(secretBytes: secret)
    } catch {
      // A 32-byte SHA-256 digest is always a valid x25519 secret width; this maps any
      // unexpected constructor failure to a typed, value-free error.
      throw MasterKeyPeerError.masterKeyUnreadable
    }
  }
}

public enum DesktopDevicePairingReadinessMode: String, Sendable, Equatable {
  case ready
  case unavailable
}

/// Read-only desktop pairing/read-seam readiness for Operations Overview.
///
/// This reports the PUBLIC master-derived peer key the Hub Console will use against the read seam.
/// It never enrolls a device, never writes trust state, and never exposes the host master key.
public struct DesktopDevicePairingReadiness: Sendable, Equatable {
  public let mode: DesktopDevicePairingReadinessMode
  public let publicKeyHex: String?
  public let readHost: String
  public let readPort: UInt16
  public let ownerPrincipal: String
  public let reason: String
  public let nextStep: String

  public static func evaluate(
    config: ReadProjectionServerConfig = .liveLoopback,
    ownerPrincipal: String = liveReadProjectionOwnerPrincipal,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> DesktopDevicePairingReadiness {
    do {
      let keypair = try MasterKeyPeer.deriveKeypair(
        environment: environment,
        homeDirectory: homeDirectory)
      return DesktopDevicePairingReadiness(
        mode: .ready,
        publicKeyHex: Hex.encode(keypair.publicKey),
        readHost: config.host,
        readPort: config.port,
        ownerPrincipal: ownerPrincipal,
        reason: "Desktop read-seam peer is derived and ready.",
        nextStep: "Pair mobile devices separately; this desktop status does not enroll a phone.")
    } catch {
      return DesktopDevicePairingReadiness(
        mode: .unavailable,
        publicKeyHex: nil,
        readHost: config.host,
        readPort: config.port,
        ownerPrincipal: ownerPrincipal,
        reason: "Desktop master-derived peer is unavailable.",
        nextStep: "Provision the host master key before proving desktop read-seam readiness.")
    }
  }
}
