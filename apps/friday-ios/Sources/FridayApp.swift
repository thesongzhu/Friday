// Friday — Unit 5b native iOS shell (simulator proof).
//
// A minimal SwiftUI app whose entire content is computed by the ALL-RUST core
// through the generated UniFFI Swift bindings (friday_ffi). It shows the
// connection-state projection and the protocol schema version/negotiation —
// proving the Swift <-> Rust bridge runs on the iOS simulator. No model call,
// no provider secret on the phone (friday-ffi excludes the Hub-only crates).

import SwiftUI

struct ContentView: View {
    // Every value below comes from the Rust core via UniFFI — not hardcoded in Swift.
    private let state = initialConnectionState()
    private let schemaVersion = protocolSchemaVersion()
    // 1..3 vs 2..5 -> highest common = 3 (never silently downgrades).
    private let negotiated = negotiateSchemaVersion(
        localMin: 1, localMax: 3, remoteMin: 2, remoteMax: 5)

    var body: some View {
        VStack(spacing: 14) {
            Text("Friday")
                .font(.largeTitle).bold()
            Text("All-Rust core via UniFFI")
                .font(.subheadline).foregroundStyle(.secondary)

            Divider()

            row("connection", String(describing: state))
            row("online?", connectionIsOnline(state: state) ? "yes" : "no")
            row("stale/offline?", connectionIsStaleOrOffline(state: state) ? "yes" : "no")
            row("schema version", "\(schemaVersion)")
            row("negotiated (1–3 vs 2–5)", negotiated.map { "\($0)" } ?? "incompatible")

            Divider()
            Text("rendered from Rust ✓")
                .font(.footnote).foregroundStyle(.green)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(white: 0.98))
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).bold().monospaced()
        }
    }
}

@main
struct FridayApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
