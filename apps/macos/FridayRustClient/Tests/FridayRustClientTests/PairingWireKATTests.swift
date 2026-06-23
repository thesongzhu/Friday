import XCTest
@testable import FridayRustClient

/// T3 pairing wire contract tests. These lock the Swift client to the Rust
/// `friday_protocol::Message::{Pair,PairAck,HubStatus}` serde shapes before a socket client is
/// allowed to write `device_identity` + `trusted_device` through `hub_pairing_server`.
final class PairingWireKATTests: XCTestCase {
  func testPairMessageWireContractIsRefsAndProofOnly() throws {
    let pair = PairingPairWire(
      deviceId: "device-ios-1",
      devicePubkey: Array(0..<32),
      pairingProof: Array(32..<64))
    let env = FridayEnvelope(msgId: "pair-1", sentAt: 7, message: .pair(pair))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"Pair\""))
    XCTAssertTrue(json.contains("\"device_id\":\"device-ios-1\""))
    XCTAssertTrue(json.contains("\"device_pubkey\":[0,1,2"))
    XCTAssertTrue(json.contains("\"pairing_proof\":[32,33,34"))
    XCTAssertFalse(json.contains("pairing_secret"))

    let messageObj = try messageObject(json)
    XCTAssertEqual(Set(messageObj.keys), ["kind", "device_id", "device_pubkey", "pairing_proof"])
    let back = try FridayEnvelope.decodeJSON(Data(json.utf8))
    XCTAssertEqual(back.message, .pair(pair))
  }

  func testPairAckOmitsErrorCodeWhenAcceptedAndPreservesDenialCode() throws {
    let accepted = FridayEnvelope(
      msgId: "pair-ack-ok", sentAt: 8,
      message: .pairAck(PairingPairAckWire(accepted: true)))
    let acceptedJson = String(decoding: try accepted.encodeJSON(), as: UTF8.self)
    let acceptedObj = try messageObject(acceptedJson)
    XCTAssertEqual(Set(acceptedObj.keys), ["kind", "accepted"])
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(acceptedJson.utf8)).message,
                   .pairAck(PairingPairAckWire(accepted: true)))

    let denied = FridayEnvelope(
      msgId: "pair-ack-denied", sentAt: 9,
      message: .pairAck(PairingPairAckWire(accepted: false, errorCode: .pairingDenied)))
    let deniedJson = String(decoding: try denied.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(deniedJson.contains("\"error_code\":\"PAIRING_DENIED\""))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(deniedJson.utf8)).message,
                   .pairAck(PairingPairAckWire(accepted: false, errorCode: .pairingDenied)))
  }

  func testHubStatusWireContract() throws {
    let status = PairingHubStatusWire(
      online: true,
      capabilities: ["pairing", "read_seam_enroll"],
      minVersion: 1,
      maxVersion: 13)
    let env = FridayEnvelope(msgId: "status-1", sentAt: 10, message: .hubStatus(status))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"HubStatus\""))
    XCTAssertTrue(json.contains("\"online\":true"))
    XCTAssertTrue(json.contains("\"capabilities\":[\"pairing\",\"read_seam_enroll\"]"))
    XCTAssertTrue(json.contains("\"min_version\":1"))
    XCTAssertTrue(json.contains("\"max_version\":13"))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .hubStatus(status))
  }

  private func messageObject(_ json: String) throws -> [String: Any] {
    let env = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    return try XCTUnwrap(env["message"] as? [String: Any])
  }
}
