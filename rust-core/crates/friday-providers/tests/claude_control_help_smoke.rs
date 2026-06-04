use friday_core::SyncMode;
use friday_providers::claude_control::{
    classify_remote_control_surface, classify_stream_json_surface, ClaudeHelpCapabilities,
    ClaudeRemoteControlProof,
};
use std::process::Command;

fn run_claude_help(args: &[&str]) -> String {
    let output = Command::new("claude")
        .args(args)
        .output()
        .expect("claude CLI should be installed for ignored live help smoke");
    assert!(
        output.status.success(),
        "claude {:?} failed with status {:?}",
        args,
        output.status.code()
    );
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
#[ignore = "local CLI smoke only; reads help text and does not start a model turn"]
fn claude_help_surfaces_parse_without_model_call() {
    let main_help = run_claude_help(&["--help"]);
    let remote_help = run_claude_help(&["remote-control", "--help"]);
    let capabilities = ClaudeHelpCapabilities::parse(&main_help, &remote_help);

    assert!(capabilities.has_remote_control_surface());
    assert!(capabilities.has_local_stream_surface());

    let remote =
        classify_remote_control_surface(&capabilities, ClaudeRemoteControlProof::default());
    assert_eq!(remote.sync_mode, SyncMode::ProviderNativeLinkOnly);
    assert!(remote.no_model_call);

    let local = classify_stream_json_surface(&capabilities);
    assert_eq!(local.sync_mode, SyncMode::FridayLocalMirror);
    assert!(local.no_model_call);
}
