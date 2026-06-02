// Friday — native iOS app, operator-selected design baseline (file 17 §3 / 06).
//
// Locked baseline implemented here: Cyan+Coral palette, Glass Native surfaces,
// Retro-LCD Hero Pet, restrained native micro-motion (reduce-motion aware),
// Command Sheet top-left menu (Friday/Platform/Workflows/Activity/Settings),
// Friday-first launch, Friday Home = Chat+Status with Hero Pet, Platform =
// Cards+Queues with Name+Small-Mark provider identity, Activity urgency-first,
// Memory Review recommendation-first, timeline-first Session Detail, Settings
// token/cost ledger. Every data value comes from the all-Rust core via UniFFI
// (friday_ffi). No model call, no provider secret on the phone.

import SwiftUI

// MARK: - Design tokens (Cyan + Coral, Glass Native, Neutral Plus)

enum Theme {
    static let cyan = Color(red: 0.10, green: 0.69, blue: 0.76)
    static let coral = Color(red: 0.95, green: 0.45, blue: 0.36)
    static let lcd = Color(red: 0.55, green: 0.95, blue: 0.70) // retro-LCD phosphor
    static let lcdBg = Color(red: 0.06, green: 0.10, blue: 0.09)
    static let ink = Color.primary
    static let sub = Color.secondary

    // Risk semantics (info/success/warning/danger/blocked) via color+icon+text.
    static func risk(_ kind: String) -> Color {
        switch kind {
        case "success", "done", "direct": return cyan
        case "warning", "running", "pending": return Color.orange
        case "danger", "failed", "fallback": return coral
        default: return sub
        }
    }
}

// Glass Native card surface.
private struct GlassCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Theme.cyan.opacity(0.18), lineWidth: 1)
            )
    }
}
extension View { func glass() -> some View { modifier(GlassCard()) } }

// Status chip: icon + chip + text (locked status-label style).
private struct Chip: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption2).bold().monospaced()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.16), in: Capsule())
            .foregroundStyle(color)
    }
}

// MARK: - Retro-LCD Hero Pet (mood companion, not a status source of truth)

struct HeroPet: View {
    var online: Bool
    // A small pixel cat face drawn on a retro-LCD panel.
    private let face: [String] = [
        "X..XX..X",
        ".XXXXXX.",
        "X.XOXO.X",
        "X.XXXX.X",
        "X.X..X.X",
        ".XXXXXX.",
    ]
    var body: some View {
        VStack(spacing: 6) {
            Canvas { ctx, size in
                let cols = 8, rows = face.count
                let cell = min(size.width / CGFloat(cols), size.height / CGFloat(rows))
                for (r, line) in face.enumerated() {
                    for (c, ch) in Array(line).enumerated() where ch != "." {
                        let on = ch == "X"
                        let rect = CGRect(x: CGFloat(c) * cell + 1, y: CGFloat(r) * cell + 1,
                                          width: cell - 2, height: cell - 2)
                        ctx.fill(Path(roundedRect: rect, cornerRadius: 1),
                                 with: .color(on ? Theme.lcd : Theme.lcd.opacity(0.35)))
                    }
                }
            }
            .frame(width: 132, height: 100)
            .padding(10)
            .background(Theme.lcdBg, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.lcd.opacity(0.25), lineWidth: 1))
            Text(online ? "Friday is here" : "Friday is offline")
                .font(.caption2).foregroundStyle(Theme.sub)
        }
    }
}

// MARK: - Navigation

enum Dest: String, CaseIterable, Identifiable {
    case friday = "Friday", platform = "Platform", workflows = "Workflows"
    case activity = "Activity", settings = "Settings"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .friday: return "bubble.left.and.text.bubble.right"
        case .platform: return "square.grid.2x2"
        case .workflows: return "arrow.triangle.branch"
        case .activity: return "bell.badge"
        case .settings: return "gearshape"
        }
    }
}

// A timeline target (Session Detail), shown timeline-first.
struct SessionRef: Hashable { let title: String; let source: String; let destination: String }

// MARK: - Shared phone DB path + helpers

let dbPath: String = FileManager.default
    .urls(for: .documentDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("friday.db").path

private func sectionHeader(_ title: String, _ sub: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.title3).bold()
        Text(sub).font(.caption2).foregroundStyle(Theme.sub)
    }.frame(maxWidth: .infinity, alignment: .leading)
}

// MARK: - Root (Command Sheet menu, Friday-first)

struct RootView: View {
    @State private var dest: Dest = .friday
    @State private var menuOpen = false
    @State private var path: [SessionRef] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                switch dest {
                case .friday: FridayHome(path: $path)
                case .platform: PlatformView(path: $path)
                case .workflows: WorkflowsView()
                case .activity: ActivityView(path: $path)
                case .settings: SettingsView()
                }
            }
            .navigationTitle(dest.rawValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { menuOpen = true } label: {
                        Image(systemName: "command").foregroundStyle(Theme.cyan)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Small Mark for the app itself.
                    Circle().fill(Theme.coral).frame(width: 12, height: 12)
                }
            }
            .navigationDestination(for: SessionRef.self) { SessionDetail(ref: $0) }
        }
        .tint(Theme.cyan)
        .sheet(isPresented: $menuOpen) { CommandSheet(dest: $dest, open: $menuOpen) }
    }
}

// Command Sheet: the locked top-left menu.
struct CommandSheet: View {
    @Binding var dest: Dest
    @Binding var open: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Friday").font(.largeTitle).bold()
                Text("command").font(.caption).foregroundStyle(Theme.cyan).monospaced()
                Spacer()
            }.padding(.bottom, 8)
            ForEach(Dest.allCases) { d in
                Button { dest = d; open = false } label: {
                    HStack(spacing: 14) {
                        Image(systemName: d.icon).frame(width: 26).foregroundStyle(Theme.cyan)
                        Text(d.rawValue).font(.title3).foregroundStyle(Theme.ink)
                        Spacer()
                        if d == dest { Chip(text: "open", color: Theme.cyan) }
                    }.padding(.vertical, 12)
                }
                if d != Dest.allCases.last { Divider() }
            }
            Spacer()
            Text("All-Rust core via UniFFI · v1 NO-GO (greenfield)")
                .font(.caption2).foregroundStyle(Theme.sub)
        }
        .padding(24)
        .presentationDetents([.fraction(0.6), .large])
    }
}

// MARK: - Friday Home (Chat + Status, Hero Pet)

struct FridayHome: View {
    @Binding var path: [SessionRef]
    private let state = initialConnectionState()
    private let inbox = sampleActivityInbox()
    private var online: Bool { connectionIsOnline(state: state) }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                HeroPet(online: online).padding(.top, 4)

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Status").font(.headline)
                        Spacer()
                        Chip(text: String(describing: state).lowercased(),
                             color: online ? Theme.cyan : Theme.coral)
                    }
                    statusRow("link", online ? "online" : "offline / stale", online ? Theme.cyan : Theme.coral)
                    statusRow("number", "protocol v\(protocolSchemaVersion())", Theme.sub)
                    statusRow("arrow.left.arrow.right",
                              "negotiated \(negotiateSchemaVersion(localMin: 1, localMax: 3, remoteMin: 2, remoteMax: 5).map { "\($0)" } ?? "—")",
                              Theme.sub)
                }.glass()

                // Chat composer (honest: real Friday chat needs a connected Hub).
                VStack(alignment: .leading, spacing: 8) {
                    Text("Chat").font(.headline)
                    HStack {
                        Text("Ask Friday…").foregroundStyle(Theme.sub)
                        Spacer()
                        Image(systemName: "arrow.up.circle.fill").foregroundStyle(Theme.cyan.opacity(0.4))
                    }
                    .padding(12)
                    .background(Color(white: 0.5).opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    Text("connect a Hub to chat (Hub↔phone sync is operator/env-gated)")
                        .font(.caption2).foregroundStyle(Theme.sub)
                }.glass()

                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text("Needs Me").font(.headline); Spacer(); Chip(text: "\(inbox.count)", color: Theme.coral) }
                    Text("urgency-first · sample").font(.caption2).foregroundStyle(Theme.sub)
                    ForEach(inbox.prefix(3), id: \.id) { item in
                        Button { path.append(SessionRef(title: item.reason, source: item.source, destination: item.destination)) } label: {
                            needsMeRow(item)
                        }.buttonStyle(.plain)
                    }
                }.glass()
            }.padding(16)
        }
        .background(bg)
    }
    private func statusRow(_ icon: String, _ text: String, _ color: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).frame(width: 22).foregroundStyle(color)
            Text(text).foregroundStyle(Theme.ink); Spacer()
        }
    }
}

private func needsMeRow(_ item: NeedsMeItemFfi) -> some View {
    HStack(alignment: .top, spacing: 10) {
        Chip(text: item.source.uppercased(), color: providerColor(item.source))
        VStack(alignment: .leading, spacing: 2) {
            Text(item.reason).foregroundStyle(Theme.ink)
            Text(item.destination).font(.caption2).foregroundStyle(Theme.sub)
        }
        Spacer()
        Text("p\(item.priority)").font(.caption).monospaced().foregroundStyle(Theme.coral)
    }
}

func providerColor(_ s: String) -> Color {
    switch s { case "claude": return Theme.coral; case "codex": return Theme.cyan
    case "workflow": return .purple; case "memory": return .teal; default: return Theme.sub }
}

private var bg: some View { Color(white: 0.97).ignoresSafeArea() }

// MARK: - Platform (Cards + Queues, Name + Small Mark)

struct PlatformView: View {
    @Binding var path: [SessionRef]
    private let inbox = sampleActivityInbox()
    private let providers: [(String, String)] = [("codex", "Codex"), ("claude", "Claude"), ("deepseek", "DeepSeek")]
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                sectionHeader("Providers", "cards open the provider workspace")
                ForEach(providers, id: \.0) { id, name in
                    HStack(spacing: 12) {
                        Circle().fill(providerColor(id)).frame(width: 14, height: 14) // Small Mark
                        VStack(alignment: .leading) {
                            Text(name).font(.headline)
                            Text("Rust route" + (id == "deepseek" ? " · live" : " · session-control")).font(.caption2).foregroundStyle(Theme.sub)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(Theme.sub)
                    }.glass()
                }
                sectionHeader("Queues", "Needs-Me, urgency-first")
                ForEach(inbox, id: \.id) { item in
                    Button { path.append(SessionRef(title: item.reason, source: item.source, destination: item.destination)) } label: {
                        needsMeRow(item).glass()
                    }.buttonStyle(.plain)
                }
            }.padding(16)
        }.background(bg)
    }
}

// MARK: - Activity (urgency-first; live phone store + real write)

struct ActivityView: View {
    @Binding var path: [SessionRef]
    @State private var items: [ActivityItemFfi] = []
    @State private var note = ""
    @State private var err = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                sectionHeader("Activity", "live · phone SQLite · tap a row to mark done")
                if !note.isEmpty { Chip(text: note, color: Theme.cyan).frame(maxWidth: .infinity, alignment: .leading) }
                if !err.isEmpty { Text(err).font(.caption2).foregroundStyle(Theme.coral) }
                ForEach(items, id: \.activityId) { a in
                    Button { if a.state != "done" { mark(a) } } label: { activityRow(a) }
                        .buttonStyle(.plain).disabled(a.state == "done")
                }
            }.padding(16)
        }
        .background(bg)
        .onAppear(perform: load)
    }
    private func activityRow(_ a: ActivityItemFfi) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Chip(text: a.state.uppercased(), color: Theme.risk(a.state))
            VStack(alignment: .leading, spacing: 2) {
                Text(a.summary).foregroundStyle(Theme.ink)
                Text(a.kind).font(.caption2).foregroundStyle(Theme.sub)
            }
            Spacer()
            Image(systemName: a.state == "done" ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(a.state == "done" ? Theme.cyan : Theme.sub)
        }.glass()
    }
    private func load() {
        let r = phoneActivityDemo(dbPath: dbPath)
        guard r.ok else { err = r.error; return }
        if let p = r.items.first(where: { $0.state == "pending" }) {
            let after = markActivityDone(dbPath: dbPath, activityId: p.activityId, now: 100)
            if after.ok { items = after.items; note = "✓ marked “\(p.summary)” done (persisted)"; return }
        }
        items = r.items
    }
    private func mark(_ a: ActivityItemFfi) {
        let after = markActivityDone(dbPath: dbPath, activityId: a.activityId, now: 200)
        if after.ok { items = after.items; note = "✓ marked “\(a.summary)” done (persisted)" } else { err = after.error }
    }
}

// MARK: - Workflows = Memory Review (recommendation-first, no silent write)

struct WorkflowsView: View {
    private let mem = sampleMemoryReview()
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                sectionHeader("Memory Review", "recommendation-first · awaiting confirm/reject · never auto-saved")
                ForEach(mem, id: \.memoryId) { m in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Chip(text: m.scope.uppercased(), color: Theme.cyan); Spacer()
                            Chip(text: String(describing: m.state).lowercased(), color: Theme.risk(String(describing: m.state).lowercased())) }
                        Text(m.preview).foregroundStyle(Theme.ink)
                        Text(m.confidence).font(.caption2).foregroundStyle(Theme.sub)
                        HStack(spacing: 10) {
                            Label("Confirm", systemImage: "checkmark").font(.caption).foregroundStyle(Theme.cyan)
                            Label("Reject", systemImage: "xmark").font(.caption).foregroundStyle(Theme.coral)
                            Spacer()
                        }
                    }.glass()
                }
                Text("memory_item is Hub-only; phone shows the review surface — confirm/reject persists on the Hub (sync env-gated).")
                    .font(.caption2).foregroundStyle(Theme.sub)
            }.padding(16)
        }.background(bg)
    }
}

// MARK: - Settings (token/model ledger, grouped cards)

struct SettingsView: View {
    private let tokens = phoneTokenUsage(dbPath: dbPath)
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                sectionHeader("Token / cost ledger", "live · phone ledger · fallback always shown (02 §13)")
                if tokens.ok {
                    let total = tokens.items.reduce(0) { $0 + $1.totalTokens }
                    HStack {
                        VStack(alignment: .leading) { Text("\(total)").font(.title).bold().foregroundStyle(Theme.cyan); Text("total tokens").font(.caption2).foregroundStyle(Theme.sub) }
                        Spacer()
                        VStack(alignment: .trailing) { Text(String(format: "$%.4f", tokens.items.compactMap { $0.costEstimate }.reduce(0,+))).font(.title3).bold(); Text("est. cost").font(.caption2).foregroundStyle(Theme.sub) }
                    }.glass()
                    ForEach(Array(tokens.items.enumerated()), id: \.offset) { _, t in
                        HStack {
                            Circle().fill(Theme.cyan).frame(width: 10, height: 10)
                            VStack(alignment: .leading) { Text("\(t.provider)/\(t.model)").foregroundStyle(Theme.ink)
                                Text("\(t.totalTokens) tok · \(t.costEstimate.map { String(format: "$%.4f", $0) } ?? "—")").font(.caption2).foregroundStyle(Theme.sub) }
                            Spacer()
                            Chip(text: t.fallback ? "fallback" : "direct", color: t.fallback ? Theme.coral : Theme.cyan)
                        }.glass()
                    }
                } else { Text(tokens.error).font(.caption2).foregroundStyle(Theme.coral) }
            }.padding(16)
        }.background(bg)
    }
}

// MARK: - Session Detail (timeline-first)

struct SessionDetail: View {
    let ref: SessionRef
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Circle().fill(providerColor(ref.source)).frame(width: 14, height: 14)
                    Text(ref.source.capitalized).font(.headline); Spacer()
                    Text(ref.destination).font(.caption2).monospaced().foregroundStyle(Theme.sub)
                }.padding(.bottom, 12)
                ForEach(Array(timeline.enumerated()), id: \.offset) { i, ev in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(spacing: 0) {
                            Circle().fill(ev.1).frame(width: 12, height: 12)
                            if i != timeline.count - 1 { Rectangle().fill(Theme.cyan.opacity(0.2)).frame(width: 2, height: 34) }
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ev.0).foregroundStyle(Theme.ink)
                            Text(ev.2).font(.caption2).foregroundStyle(Theme.sub)
                        }.padding(.bottom, 14)
                        Spacer()
                    }
                }
            }.padding(20)
        }
        .background(bg)
        .navigationTitle("Session")
        .navigationBarTitleDisplayMode(.inline)
    }
    // A representative timeline (real session-event streaming is sync-gated).
    private var timeline: [(String, Color, String)] {
        [(ref.title, Theme.coral, "needs your decision"),
         ("Friday opened the session", Theme.cyan, "Rust core · routed"),
         ("Awaiting checkpoint", Theme.risk("pending"), "no silent action"),
         ("Will record to ledger", Theme.sub, "token/cost on completion")]
    }
}

@main
struct FridayApp: App {
    var body: some Scene { WindowGroup { RootView() } }
}
