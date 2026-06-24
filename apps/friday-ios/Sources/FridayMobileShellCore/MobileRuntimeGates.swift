import Foundation

public enum MobileRuntimeGates {
  public static func useDeviceKeypair(args: [String], env: [String: String]) -> Bool {
    args.contains("--live-device-keypair") || env["FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR"] == "1"
  }

  public static func simulatorFileDeviceKeypairRequested(args: [String], env: [String: String]) -> Bool {
    args.contains("--simulator-file-device-keypair")
      || env["FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR"] == "1"
  }

  public static func liveReadRequested(args: [String], env: [String: String]) -> Bool {
    args.contains("--live-read") || env["FRIDAY_MOBILE_LIVE_READ"] == "1"
  }

  public static func liveWriteRequested(args: [String], env: [String: String]) -> Bool {
    args.contains("--live-write") || env["FRIDAY_MOBILE_LIVE_WRITE"] == "1"
  }

  public static func livePairingRequested(args: [String], env: [String: String]) -> Bool {
    args.contains("--live-pairing") || env["FRIDAY_MOBILE_LIVE_PAIRING"] == "1"
  }

  public static func runControlRequested(args: [String], env: [String: String]) -> Bool {
    args.contains("--agent-run-control-via-rust")
      || args.contains("--run-control")
      || env["FRIDAY_MOBILE_AGENT_RUN_CONTROL_VIA_RUST"] == "1"
      || env["FRIDAY_AGENT_RUN_CONTROL_VIA_RUST"] == "1"
  }
}
