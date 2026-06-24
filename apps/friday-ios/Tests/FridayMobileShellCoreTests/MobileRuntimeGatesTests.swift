import Testing
@testable import FridayMobileShellCore

@Test
func mobileRuntimeGatesDefaultOff() {
  #expect(!MobileRuntimeGates.liveReadRequested(args: [], env: [:]))
  #expect(!MobileRuntimeGates.liveWriteRequested(args: [], env: [:]))
  #expect(!MobileRuntimeGates.livePairingRequested(args: [], env: [:]))
  #expect(!MobileRuntimeGates.useDeviceKeypair(args: [], env: [:]))
  #expect(!MobileRuntimeGates.simulatorFileDeviceKeypairRequested(args: [], env: [:]))
  #expect(!MobileRuntimeGates.runControlRequested(args: [], env: [:]))
}

@Test
func mobileRuntimeGatesAcceptExplicitArgs() {
  #expect(MobileRuntimeGates.liveReadRequested(args: ["--live-read"], env: [:]))
  #expect(MobileRuntimeGates.liveWriteRequested(args: ["--live-write"], env: [:]))
  #expect(MobileRuntimeGates.livePairingRequested(args: ["--live-pairing"], env: [:]))
  #expect(MobileRuntimeGates.useDeviceKeypair(args: ["--live-device-keypair"], env: [:]))
  #expect(MobileRuntimeGates.simulatorFileDeviceKeypairRequested(
    args: ["--simulator-file-device-keypair"],
    env: [:]))
  #expect(MobileRuntimeGates.runControlRequested(args: ["--agent-run-control-via-rust"], env: [:]))
  #expect(MobileRuntimeGates.runControlRequested(args: ["--run-control"], env: [:]))
}

@Test
func mobileRuntimeGatesAcceptExplicitEnv() {
  #expect(MobileRuntimeGates.liveReadRequested(args: [], env: ["FRIDAY_MOBILE_LIVE_READ": "1"]))
  #expect(MobileRuntimeGates.liveWriteRequested(args: [], env: ["FRIDAY_MOBILE_LIVE_WRITE": "1"]))
  #expect(MobileRuntimeGates.livePairingRequested(args: [], env: ["FRIDAY_MOBILE_LIVE_PAIRING": "1"]))
  #expect(MobileRuntimeGates.useDeviceKeypair(args: [], env: ["FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR": "1"]))
  #expect(MobileRuntimeGates.simulatorFileDeviceKeypairRequested(
    args: [],
    env: ["FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR": "1"]))
  #expect(MobileRuntimeGates.runControlRequested(
    args: [],
    env: ["FRIDAY_MOBILE_AGENT_RUN_CONTROL_VIA_RUST": "1"]))
  #expect(MobileRuntimeGates.runControlRequested(args: [], env: ["FRIDAY_AGENT_RUN_CONTROL_VIA_RUST": "1"]))
}

@Test
func mobileRuntimeGatesReadEndpointOverridesAreExplicit() {
  #expect(MobileRuntimeGates.liveReadHostOverride(args: [], env: [:]) == nil)
  #expect(MobileRuntimeGates.liveReadPortOverride(args: [], env: [:]) == .absent)

  #expect(MobileRuntimeGates.liveReadHostOverride(
    args: ["--live-read-host", "127.0.0.1"],
    env: [:]) == "127.0.0.1")
  #expect(MobileRuntimeGates.liveReadHostOverride(
    args: [],
    env: ["FRIDAY_MOBILE_LIVE_READ_HOST": "localhost"]) == "localhost")

  #expect(MobileRuntimeGates.liveReadPortOverride(
    args: ["--live-read-port", "59151"],
    env: [:]) == .value(59151))
  #expect(MobileRuntimeGates.liveReadPortOverride(
    args: [],
    env: ["FRIDAY_MOBILE_LIVE_READ_PORT": "59152"]) == .value(59152))
}

@Test
func mobileRuntimeGatesReadPortOverrideRejectsBadValues() {
  #expect(MobileRuntimeGates.liveReadPortOverride(
    args: ["--live-read-port", "0"],
    env: [:]) == .invalid("0"))
  #expect(MobileRuntimeGates.liveReadPortOverride(
    args: [],
    env: ["FRIDAY_MOBILE_LIVE_READ_PORT": "nope"]) == .invalid("nope"))
}

@Test
func mobileRuntimeGatesDoNotAcceptTruthyLookalikes() {
  #expect(!MobileRuntimeGates.liveReadRequested(args: [], env: ["FRIDAY_MOBILE_LIVE_READ": "true"]))
  #expect(!MobileRuntimeGates.liveWriteRequested(args: [], env: ["FRIDAY_MOBILE_LIVE_WRITE": "yes"]))
  #expect(!MobileRuntimeGates.livePairingRequested(args: [], env: ["FRIDAY_MOBILE_LIVE_PAIRING": "TRUE"]))
  #expect(!MobileRuntimeGates.simulatorFileDeviceKeypairRequested(
    args: [],
    env: ["FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR": "true"]))
  #expect(!MobileRuntimeGates.runControlRequested(
    args: [],
    env: ["FRIDAY_MOBILE_AGENT_RUN_CONTROL_VIA_RUST": "true"]))
}
