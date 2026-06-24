import Foundation

public enum MobileRuntimeGates {
  public enum LiveReadPortOverride: Equatable, Sendable {
    case absent
    case value(UInt16)
    case invalid(String)
  }

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

  public static func liveReadHostOverride(args: [String], env: [String: String]) -> String? {
    if let arg = value(after: "--live-read-host", in: args), !arg.isEmpty {
      return arg
    }
    let envValue = env["FRIDAY_MOBILE_LIVE_READ_HOST"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    return envValue?.isEmpty == false ? envValue : nil
  }

  public static func liveReadPortOverride(args: [String], env: [String: String]) -> LiveReadPortOverride {
    guard let raw = value(after: "--live-read-port", in: args)
      ?? env["FRIDAY_MOBILE_LIVE_READ_PORT"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    else {
      return .absent
    }
    guard let port = UInt16(raw), port > 0 else {
      return .invalid(raw)
    }
    return .value(port)
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

  private static func value(after flag: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else {
      return nil
    }
    return args[index + 1]
  }
}
