import Foundation
import CryptoKit
@preconcurrency import Sodium

/// **The Swift client-half of the friday-crypto sealed-WS handshake primitives** — a
/// byte-exact port of the Rust `friday-crypto` / `friday-hub` primitives the Rust
/// read-projection server requires, mirroring the TS reference client
/// (`src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-crypto.ts`).
///
/// ## The crypto stack (and WHY each half)
/// - **X25519 ECDH + HKDF-SHA256** → Apple **CryptoKit** (`Curve25519.KeyAgreement`
///   + `HKDF<SHA256>`). Curve25519 + HKDF-SHA256 are standard and byte-match the Rust
///   `x25519-dalek` + `hkdf` stack — PROVEN by opening a Rust-sealed blob under the
///   Swift-derived key (KAT K1).
/// - **XChaCha20-Poly1305 (24-byte nonce)** → swift-sodium's `Sodium`
///   (`aead.xchacha20poly1305ietf`, a libsodium binding). This is MANDATORY:
///   CryptoKit's `ChaChaPoly` is the **12-byte IETF** variant and would NOT byte-match
///   the Rust `chacha20poly1305::XChaCha20Poly1305` (24-byte XNonce). libsodium's
///   `_ietf` XChaCha variant is the correct 24-byte-nonce match — PROVEN by opening a
///   Rust-sealed blob (KAT K2) and by the Rust server accepting a Swift-built
///   `auth_proof` (deferred live AC).
///
/// ## Provenance discipline (mirrors the TS KATs)
/// A Swift-seals-then-Swift-opens roundtrip is CIRCULAR (it proves nothing about Rust
/// interop). The trustworthy proof is Rust-produced bytes that Swift must reproduce or
/// open — see `KATTests` and the checked-in `B1_KAT` fixtures.
public enum FridayCrypto {
  /// X25519 raw public-key width (bytes). Mirrors `X25519_PUBKEY_LEN`.
  public static let x25519PublicKeyLen = 32
  /// X25519 raw secret-scalar width (bytes).
  public static let x25519SecretLen = 32
  /// XChaCha20-Poly1305 nonce width (bytes). Mirrors RustCrypto `XNonce`.
  public static let xchachaNonceLen = 24
  /// Poly1305 tag width (bytes), appended to the ciphertext (RustCrypto/noble layout).
  public static let poly1305TagLen = 16
  /// Derived session-key width (bytes).
  public static let sessionKeyLen = 32

  /// HKDF info string. Mirrors `friday-crypto/src/session.rs::SESSION_KDF_INFO`
  /// (`b"friday-session-key-v1"`). The session key is
  /// `HKDF(salt=zero32, ikm=ecdh, info)`.
  public static let sessionKdfInfo = Array("friday-session-key-v1".utf8)

  /// HKDF salt. Rust uses `Hkdf::<Sha256>::new(None, shared)` (salt = `None`), which
  /// RFC 5869 treats as a string of HashLen (32) ZERO bytes — NOT CryptoKit's default
  /// empty salt by name. We pass an EXPLICIT 32-zero-byte salt so the derivation is
  /// unambiguous and matches the Rust `agree()` (verified byte-equal in KAT K1).
  private static let hkdfZeroSalt = Data(repeating: 0, count: 32)

  /// A fresh `Sodium` handle per call. libsodium's one-time `sodium_init` is idempotent +
  /// thread-safe, and a `Sodium()` value is cheap (it just holds the API structs); creating
  /// it locally sidesteps Swift 6 global-actor isolation on a shared mutable global.
  static func makeSodium() -> Sodium { Sodium() }
}

// MARK: - Errors

public enum FridayCryptoError: Error, Equatable {
  /// A key/nonce/pubkey had the wrong width.
  case badLength(String)
  /// Seal (encrypt) failed inside libsodium.
  case sealFailed
  /// Open (decrypt/authenticate) failed — wrong key, flipped byte, mismatched AAD,
  /// or truncated tag. The fail-closed signal (mirrors `friday-crypto::CryptoError::Open`).
  case openFailed
  /// A wire `[nonce_len][nonce][ciphertext]` frame was empty or truncated.
  case malformedSealedFrame
}

// MARK: - Sealed

/// A sealed blob: the 24-byte XChaCha20-Poly1305 `nonce` plus the `ciphertext` with the
/// 16-byte Poly1305 tag APPENDED (RustCrypto/noble layout). Mirrors `friday-crypto::Sealed`.
public struct Sealed: Equatable {
  public let nonce: [UInt8]
  public let ciphertext: [UInt8]

  public init(nonce: [UInt8], ciphertext: [UInt8]) {
    self.nonce = nonce
    self.ciphertext = ciphertext
  }
}

// MARK: - X25519 keypair + session-key agreement (CryptoKit)

extension FridayCrypto {
  /// A device's X25519 keypair (the Swift client half). Mirrors `DeviceKeypair`.
  public struct DeviceKeypair {
    private let secret: Curve25519.KeyAgreement.PrivateKey
    /// The raw 32-byte X25519 public key (sent to the server in the cleartext preamble).
    public let publicKey: [UInt8]

    /// Generate a fresh keypair from the system CSPRNG. Mirrors `DeviceKeypair::generate`.
    public init() {
      self.secret = Curve25519.KeyAgreement.PrivateKey()
      self.publicKey = [UInt8](self.secret.publicKey.rawRepresentation)
    }

    /// Reconstruct from a stored 32-byte X25519 secret scalar. Mirrors
    /// `DeviceKeypair::from_secret_bytes`: the public half is DERIVED from the secret, so
    /// two callers with the same secret get the same pubkey (used to enroll the client in
    /// the server's peer-allowlist before the handshake).
    public init(secretBytes: [UInt8]) throws {
      guard secretBytes.count == FridayCrypto.x25519SecretLen else {
        throw FridayCryptoError.badLength("x25519 secret must be 32 bytes")
      }
      self.secret = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(secretBytes))
      self.publicKey = [UInt8](self.secret.publicKey.rawRepresentation)
    }

    /// Derive the shared session key from this device's secret and a peer's raw 32-byte
    /// public key: `HKDF-SHA256(salt=zero32, ikm=X25519(secret, peerPub),
    /// info="friday-session-key-v1")`. Byte-identical to `DeviceKeypair::agree` (KAT K1).
    public func agree(peerPublicKey: [UInt8]) throws -> [UInt8] {
      guard peerPublicKey.count == FridayCrypto.x25519PublicKeyLen else {
        throw FridayCryptoError.badLength("x25519 public key must be 32 bytes")
      }
      let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(peerPublicKey))
      let shared = try secret.sharedSecretFromKeyAgreement(with: peer)
      // HKDF over the raw 32-byte ECDH output with the EXPLICIT 32-zero-byte salt and the
      // session info — matching Rust `Hkdf::<Sha256>::new(None, shared).expand(info)`.
      let okm = shared.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: FridayCrypto.hkdfZeroSalt,
        sharedInfo: Data(FridayCrypto.sessionKdfInfo),
        outputByteCount: FridayCrypto.sessionKeyLen
      )
      return okm.withUnsafeBytes { [UInt8]($0) }
    }
  }
}

// MARK: - XChaCha20-Poly1305 AEAD (swift-sodium / libsodium)

extension FridayCrypto {
  /// Encrypt `plaintext` under `key` authenticating `aad`, with a fresh random 24-byte
  /// nonce. Mirrors `friday-crypto::seal`. The returned `ciphertext` carries the 16-byte
  /// Poly1305 tag appended (RustCrypto/noble layout). Rust-openable (KAT K2 roundtrip).
  public static func seal(key: [UInt8], plaintext: [UInt8], aad: [UInt8]) throws -> Sealed {
    guard key.count == sessionKeyLen else {
      throw FridayCryptoError.badLength("session key must be 32 bytes")
    }
    // swift-sodium's explicit-nonce form returns (authenticatedCipherText, nonce) where the
    // tag is appended to the ciphertext (count = message + ABytes). We seal under a fresh
    // libsodium-generated nonce and keep them separated so we control the wire framing.
    let sodium = makeSodium()
    guard let result: (authenticatedCipherText: Bytes, nonce: Bytes) =
      sodium.aead.xchacha20poly1305ietf.encrypt(
        message: plaintext,
        secretKey: key,
        additionalData: aad.isEmpty ? nil : aad
      )
    else {
      throw FridayCryptoError.sealFailed
    }
    return Sealed(nonce: result.nonce, ciphertext: result.authenticatedCipherText)
  }

  /// Decrypt + authenticate `sealed` under `key` with `aad`. Mirrors `friday-crypto::open`:
  /// throws `.openFailed` on ANY tamper (wrong key, flipped byte, mismatched AAD, truncated
  /// tag) or `.badLength` on a wrong-width nonce. Opens a Rust-produced seal in KAT K1/K2.
  public static func open(key: [UInt8], sealed: Sealed, aad: [UInt8]) throws -> [UInt8] {
    guard key.count == sessionKeyLen else {
      throw FridayCryptoError.badLength("session key must be 32 bytes")
    }
    guard sealed.nonce.count == xchachaNonceLen else {
      throw FridayCryptoError.badLength("xchacha nonce must be 24 bytes")
    }
    let sodium = makeSodium()
    guard let pt = sodium.aead.xchacha20poly1305ietf.decrypt(
      authenticatedCipherText: sealed.ciphertext,
      secretKey: key,
      nonce: sealed.nonce,
      additionalData: aad.isEmpty ? nil : aad
    ) else {
      // Bad tag / wrong key / wrong AAD — the caller treats this as fail-closed.
      throw FridayCryptoError.openFailed
    }
    return pt
  }
}

// MARK: - On-wire sealed framing

extension FridayCrypto {
  /// Encode a `Sealed` to the on-wire form `[nonce_len:u8][nonce][ciphertext]`. Mirrors
  /// BOTH `friday-transport::encode_sealed` (the envelope body) AND the bin's identical
  /// `encode_sealed_proof` (the `auth_proof`) — one layout for both, the SAME bytes the TS
  /// reference client speaks.
  public static func encodeSealed(_ sealed: Sealed) -> [UInt8] {
    var out = [UInt8]()
    out.reserveCapacity(1 + sealed.nonce.count + sealed.ciphertext.count)
    out.append(UInt8(sealed.nonce.count & 0xff))
    out.append(contentsOf: sealed.nonce)
    out.append(contentsOf: sealed.ciphertext)
    return out
  }

  /// Decode the on-wire sealed form back into a `Sealed`. Mirrors `decode_sealed` /
  /// `decode_sealed_proof`: throws `.malformedSealedFrame` on an empty/too-short frame
  /// (the caller treats a throw as fail-closed, never a panic).
  public static func decodeSealed(_ wire: [UInt8]) throws -> Sealed {
    guard let nlenByte = wire.first else {
      throw FridayCryptoError.malformedSealedFrame
    }
    let nlen = Int(nlenByte)
    guard wire.count >= 1 + nlen else {
      throw FridayCryptoError.malformedSealedFrame
    }
    return Sealed(
      nonce: Array(wire[1..<(1 + nlen)]),
      ciphertext: Array(wire[(1 + nlen)...])
    )
  }
}

// MARK: - Auth bindings (nonce-bound challenge + per-request AAD)

extension FridayCrypto {
  /// The per-handshake challenge the peer must seal: `challenge ++ session_nonce`. Mirrors
  /// `hub_server::nonce_bound_challenge`. The `sessionNonce` is the 64-byte token from the
  /// preamble — used VERBATIM (it is the hex chars of a 32-byte CSPRNG delivered as 64
  /// ASCII bytes; the server binds those same 64 bytes — do NOT hex-decode it to 32 bytes).
  public static func nonceBoundChallenge(_ challenge: [UInt8], sessionNonce: [UInt8]) -> [UInt8] {
    var out = [UInt8]()
    out.reserveCapacity(challenge.count + sessionNonce.count)
    out.append(contentsOf: challenge)
    out.append(contentsOf: sessionNonce)
    return out
  }

  /// The per-request auth AAD:
  /// `aad ++ u32be(len(principal)) ++ principal ++ u32be(len(boundContext)) ++ boundContext`,
  /// each field LENGTH-DELIMITED with a 4-byte big-endian prefix. Mirrors
  /// `hub_server::auth_aad` — so an `auth_proof` can't be lifted to a different
  /// `(principal, boundContext)`. The READ path passes `boundContext = request_id.utf8`
  /// (the write path passes `run_id.utf8`); the function is byte-identical for both.
  public static func authAad(_ aad: [UInt8], forwardedPrincipal: String, boundContext: [UInt8]) -> [UInt8] {
    let principal = Array(forwardedPrincipal.utf8)
    var out = [UInt8]()
    out.reserveCapacity(aad.count + 4 + principal.count + 4 + boundContext.count)
    out.append(contentsOf: aad)
    out.append(contentsOf: beU32(UInt32(principal.count)))
    out.append(contentsOf: principal)
    out.append(contentsOf: beU32(UInt32(boundContext.count)))
    out.append(contentsOf: boundContext)
    return out
  }

  /// Build the per-request `auth_proof` bytes:
  /// `encodeSealed(seal(sessionKey, msg=nonceBoundChallenge(authChallenge, sessionNonce),
  /// aad=authAad(sessionAad, principal, boundContext)))`. Mirrors the bin's
  /// `auth_proof_bytes` / the TS `buildAuthProof` exactly — what the peer seals
  /// post-handshake (NOT precomputable before the nonce is known).
  public static func buildAuthProof(
    sessionKey: [UInt8],
    sessionNonce: [UInt8],
    sessionAad: [UInt8],
    authChallenge: [UInt8],
    forwardedPrincipal: String,
    boundContext: [UInt8]
  ) throws -> [UInt8] {
    let challenge = nonceBoundChallenge(authChallenge, sessionNonce: sessionNonce)
    let reqAad = authAad(sessionAad, forwardedPrincipal: forwardedPrincipal, boundContext: boundContext)
    let sealed = try seal(key: sessionKey, plaintext: challenge, aad: reqAad)
    return encodeSealed(sealed)
  }

  /// Big-endian 4-byte encoding of a `UInt32` (the length prefix in `auth_aad`).
  private static func beU32(_ v: UInt32) -> [UInt8] {
    [UInt8(truncatingIfNeeded: v >> 24), UInt8(truncatingIfNeeded: v >> 16),
     UInt8(truncatingIfNeeded: v >> 8), UInt8(truncatingIfNeeded: v)]
  }
}

// MARK: - Hex helpers (test/wire support)

public enum Hex {
  /// Lowercase-hex encode. Mirrors the bin's `hex_encode` (the owner-sealed projection
  /// ciphertext rides a `String` field as hex).
  public static func encode(_ bytes: [UInt8]) -> String {
    var s = ""
    s.reserveCapacity(bytes.count * 2)
    for b in bytes {
      s.append(hexDigit(b >> 4))
      s.append(hexDigit(b & 0x0f))
    }
    return s
  }

  /// Hex-decode. Throws on odd length / non-hex (fail-closed at the caller). Mirrors the
  /// bin's `hex_decode` validation discipline.
  public static func decode(_ s: String) throws -> [UInt8] {
    let chars = Array(s.utf8)
    guard chars.count % 2 == 0 else {
      throw FridayCryptoError.badLength("hex string has odd length")
    }
    var out = [UInt8]()
    out.reserveCapacity(chars.count / 2)
    var i = 0
    while i + 1 < chars.count {
      guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else {
        throw FridayCryptoError.badLength("invalid hex")
      }
      out.append((hi << 4) | lo)
      i += 2
    }
    return out
  }

  private static func hexDigit(_ v: UInt8) -> Character {
    let d = Int(v)
    return Character(UnicodeScalar(d < 10 ? (0x30 + d) : (0x61 + d - 10))!)
  }

  private static func nibble(_ c: UInt8) -> UInt8? {
    switch c {
    case 0x30...0x39: return c - 0x30
    case 0x61...0x66: return c - 0x61 + 10
    case 0x41...0x46: return c - 0x41 + 10
    default: return nil
    }
  }
}
