import Foundation
import FridayHubConsoleCore
import FridayRustClient

@main
struct FridayPairingProof {
  static func main() async {
    do {
      let args = try Args.parse(Array(CommandLine.arguments.dropFirst()))
      let data = try Data(contentsOf: args.manifestURL)
      let manifest = try JSONDecoder().decode(FridayPairingManifest.self, from: data)
      try manifest.validate(nowMs: Int64(Date().timeIntervalSince1970 * 1000))

      let keypair = try args.deviceSecretHex.map { try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode($0)) }
        ?? FridayCrypto.DeviceKeypair()
      let client = try RealPairingProofClientFactory.make(manifest: manifest, keypair: keypair)

      if args.statusOnly {
        let status = try await client.fetchHubStatus(manifest: manifest)
        printJSON([
          "truth": "pairing_status_only_no_trusted_device_write",
          "hub_id": manifest.hubId,
          "pairing_id": manifest.pairingId,
          "device_pubkey_hex": Hex.encode(keypair.publicKey),
          "hub_online": status.online ? "true" : "false",
          "capabilities": status.capabilities.joined(separator: ","),
        ])
        return
      }

      guard args.pair else {
        throw UsageError("pass --pair to send PairAck-producing proof, or --status-only for a no-write probe")
      }
      let ack = try await client.pairDevice(manifest: manifest, deviceId: args.deviceID)
      printJSON([
        "truth": "pairing_pairack_real_sealed_ws_no_grant_no_passport_no_operator_key",
        "hub_id": manifest.hubId,
        "pairing_id": manifest.pairingId,
        "device_id": args.deviceID,
        "device_pubkey_hex": Hex.encode(keypair.publicKey),
        "ack_accepted": ack.accepted ? "true" : "false",
        "ack_error_code": ack.errorCode.map { "\($0)" } ?? "",
      ])
      if !ack.accepted {
        exit(4)
      }
    } catch {
      fputs("FridayPairingProof: \(error)\n\n\(Args.usage)\n", stderr)
      exit(2)
    }
  }

  private static func printJSON(_ fields: [String: String]) {
    let object = fields.mapValues { value in
      value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    }
    let body = object.keys.sorted().map { key in
      "  \"\(key)\": \"\(object[key] ?? "")\""
    }.joined(separator: ",\n")
    print("{\n\(body)\n}")
  }
}

struct UsageError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

struct Args {
  let manifestURL: URL
  let pair: Bool
  let statusOnly: Bool
  let deviceID: String
  let deviceSecretHex: String?

  static let usage = """
    usage:
      swift run FridayPairingProof --manifest <qr-json> --pair [--device-id <id>] [--device-secret-hex <64-hex>]
      swift run FridayPairingProof --manifest <qr-json> --status-only [--device-secret-hex <64-hex>]

    truth:
      Sends a real sealed-WS Pair request to an explicit hub_pairing_server session.
      It never reads operator signing keys and never mints trust_grant/context_passport.
    """

  static func parse(_ raw: [String]) throws -> Args {
    var manifest: String?
    var pair = false
    var statusOnly = false
    var deviceID = "desktop-pairing-proof-\(UUID().uuidString.prefix(12))"
    var deviceSecretHex: String?
    var i = 0
    while i < raw.count {
      switch raw[i] {
      case "--manifest":
        i += 1
        guard i < raw.count else { throw UsageError("--manifest requires a path") }
        manifest = raw[i]
      case "--pair":
        pair = true
      case "--status-only":
        statusOnly = true
      case "--device-id":
        i += 1
        guard i < raw.count else { throw UsageError("--device-id requires a value") }
        deviceID = raw[i]
      case "--device-secret-hex":
        i += 1
        guard i < raw.count else { throw UsageError("--device-secret-hex requires a 64-hex value") }
        deviceSecretHex = raw[i]
      case "-h", "--help":
        throw UsageError(usage)
      default:
        throw UsageError("unknown argument \(raw[i])")
      }
      i += 1
    }
    guard pair != statusOnly else {
      throw UsageError("choose exactly one of --pair or --status-only")
    }
    guard let manifest else {
      throw UsageError("--manifest is required")
    }
    if let deviceSecretHex, deviceSecretHex.count != 64 {
      throw UsageError("--device-secret-hex must be 64 lowercase/uppercase hex characters")
    }
    return Args(
      manifestURL: URL(fileURLWithPath: manifest),
      pair: pair,
      statusOnly: statusOnly,
      deviceID: deviceID,
      deviceSecretHex: deviceSecretHex)
  }
}
