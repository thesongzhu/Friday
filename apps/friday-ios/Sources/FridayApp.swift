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

    // The phone's own SQLite file (the app sandbox). LIVE data + a real WRITE path.
    private let dbPath: String = FileManager.default
        .urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("friday.db").path
    // Token/cost usage read from the phone's own ledger (02 §13 cost transparency).
    private let tokens: PhoneTokensFfi = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return phoneTokenUsage(dbPath: dir.appendingPathComponent("friday.db").path)
    }()
    @State private var activity: [ActivityItemFfi] = []
    @State private var activityError: String = ""
    @State private var note: String = ""

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

                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("Activity").font(.headline)
                        Spacer()
                        Text("\(activity.count)").foregroundStyle(.secondary)
                    }
                    Text("live · phone SQLite · tap a row to mark done")
                        .font(.caption2).foregroundStyle(.secondary)
                    if !note.isEmpty {
                        Text(note).font(.caption2).foregroundStyle(.green)
                    }
                    if !activityError.isEmpty {
                        Text(activityError).font(.caption2).foregroundStyle(.red)
                    }
                }
                ForEach(activity, id: \.activityId) { activityRow($0) }

                Divider()

                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("Tokens / cost").font(.headline)
                        Spacer()
                        Text(tokens.ok ? "\(tokens.items.count)" : "—")
                            .foregroundStyle(.secondary)
                    }
                    Text("live · phone ledger · fallback always shown")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if tokens.ok {
                    ForEach(Array(tokens.items.enumerated()), id: \.offset) { _, t in tokenRow(t) }
                } else {
                    Text(tokens.error).font(.caption2).foregroundStyle(.red)
                }

                Divider()
                Text("rendered from Rust ✓")
                    .font(.footnote).foregroundStyle(.green)
            }
            .padding(28)
        }
        .background(Color(white: 0.98))
        .onAppear(perform: loadActivity)
    }

    // Load the phone store, then perform ONE real persisted write (mark the oldest
    // pending item done) so the screen shows a live state change through SQLite.
    // Every value comes from / goes to the real store — no UI-only mock state.
    private func loadActivity() {
        let loaded = phoneActivityDemo(dbPath: dbPath)
        guard loaded.ok else {
            activityError = loaded.error
            return
        }
        if let pending = loaded.items.first(where: { $0.state == "pending" }) {
            let after = markActivityDone(dbPath: dbPath, activityId: pending.activityId, now: 100)
            if after.ok {
                activity = after.items
                note = "✓ marked “\(pending.summary)” done (persisted)"
                return
            }
        }
        activity = loaded.items
    }

    // Tapping an item marks it done via the real SQLite write path and refreshes.
    private func markDone(_ a: ActivityItemFfi) {
        let after = markActivityDone(dbPath: dbPath, activityId: a.activityId, now: 200)
        if after.ok {
            activity = after.items
            note = "✓ marked “\(a.summary)” done (persisted)"
        } else {
            activityError = after.error
        }
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

    // One activity item from the phone's SQLite store. A non-done row is a tappable
    // control that marks it done through the real write path; done rows are inert.
    private func activityRow(_ a: ActivityItemFfi) -> some View {
        let isDone = a.state == "done"
        return Button(action: { if !isDone { markDone(a) } }) {
            HStack(alignment: .top, spacing: 10) {
                Text(a.state.uppercased())
                    .font(.caption2).bold()
                    .foregroundStyle(isDone ? Color.green : Color.secondary)
                    .frame(width: 72, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(a.summary).foregroundStyle(.primary)
                    Text(a.kind).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: isDone ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isDone ? .green : .secondary)
            }
        }
        .buttonStyle(.plain)
        .disabled(isDone)
    }

    // One token/cost row: provider/model, total tokens, $cost, and the fallback
    // flag (always surfaced — a fallback is never hidden, 02 §13).
    private func tokenRow(_ t: TokenUsageFfi) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(t.provider.uppercased())
                .font(.caption2).bold().foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(t.model)
                Text("\(t.totalTokens) tok · \(t.costEstimate.map { String(format: "$%.4f", $0) } ?? "—") · \(t.fallback ? "⚠ fallback" : "direct")")
                    .font(.caption2).foregroundStyle(t.fallback ? .orange : .secondary)
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
