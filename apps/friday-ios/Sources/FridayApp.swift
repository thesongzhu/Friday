// Friday — native iOS shell (simulator proof).
//
// A minimal SwiftUI app whose entire content is computed by the ALL-RUST core
// through the generated UniFFI Swift bindings (friday_ffi): the connection-state
// projection, the protocol schema version/negotiation, and the urgency-first
// "Needs Me" Activity inbox — proving the Swift <-> Rust bridge runs on the iOS
// simulator. No model call, no provider secret on the phone (friday-ffi excludes
// the Hub-only crates).

import SwiftUI

struct ContentView: View {
    // Every value below comes from the Rust core via UniFFI — not hardcoded in Swift.
    private let state = initialConnectionState()
    private let schemaVersion = protocolSchemaVersion()
    // 1..3 vs 2..5 -> highest common = 3 (never silently downgrades).
    private let negotiated = negotiateSchemaVersion(
        localMin: 1, localMax: 3, remoteMin: 2, remoteMax: 5)
    // Urgency-first Needs-Me inbox, built + sorted by Rust (08 §1/§2).
    private let inbox = sampleActivityInbox()
    // Memory candidates awaiting the user's review (07 §6/§7).
    private let memReview = sampleMemoryReview()

    var body: some View {
        ScrollView {
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

                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("Needs Me").font(.headline)
                        Spacer()
                        Text("\(inbox.count)").foregroundStyle(.secondary)
                    }
                    Text("sample — live Activity store pending")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(inbox, id: \.id) { needsMeRow($0) }

                Divider()

                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("Memory Review").font(.headline)
                        Spacer()
                        Text("\(memReview.count)").foregroundStyle(.secondary)
                    }
                    Text("sample — awaiting confirm/reject, never auto-saved")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(memReview, id: \.memoryId) { memoryRow($0) }

                Divider()
                Text("rendered from Rust ✓")
                    .font(.footnote).foregroundStyle(.green)
            }
            .padding(28)
        }
        .background(Color(white: 0.98))
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).bold().monospaced()
        }
    }

    // One Needs-Me item: source tag, reason + destination, urgency. Detail is
    // carried, never dropped (08 §2).
    private func needsMeRow(_ item: NeedsMeItemFfi) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(item.source.uppercased())
                .font(.caption2).bold().foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.reason)
                Text(item.destination).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Text("p\(item.priority)").font(.caption).monospaced()
        }
    }

    // One memory candidate: scope tag, preview, and its confidence + lifecycle
    // state. A candidate is never auto-confirmed (07 §6/§7).
    private func memoryRow(_ m: MemoryCandidateFfi) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(m.scope.uppercased())
                .font(.caption2).bold().foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(m.preview)
                Text("\(m.confidence) · \(String(describing: m.state).lowercased())")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}

@main
struct FridayApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
