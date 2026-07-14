// `device` (SEC-SETUP-BOOTSTRAP-001 Slice 3) is a fail-closed, DISABLED
// device-bound owner principal. It carries ZERO owner data/control authority in
// the release/default profile: the enforcement floors treat it exactly like the
// synthetic anonymous principal until the server-derived device-authority switch
// flips (which requires native-IPC caller-identity — absent today). It is added
// here to the deny path first; the allow path lands only post-preconditions.
export type FridayPrincipalType = "user" | "satellite" | "service" | "workflow-runner" | "device";
