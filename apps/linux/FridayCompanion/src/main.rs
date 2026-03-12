fn main() {
    let socket_path = std::env::var("FRIDAY_SYSTEM_COMPANION_SOCKET_PATH").unwrap_or_default();
    let auth_token_file = std::env::var("FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE").unwrap_or_default();
    let heartbeat_ms = std::env::var("FRIDAY_SYSTEM_COMPANION_HEARTBEAT_MS").unwrap_or_default();

    println!(
        "{{\"runtime\":\"linux_companion_scaffold\",\"socketPath\":\"{}\",\"authTokenFile\":\"{}\",\"heartbeatIntervalMs\":\"{}\"}}",
        socket_path.replace('"', "\\\""),
        auth_token_file.replace('"', "\\\""),
        heartbeat_ms.replace('"', "\\\""),
    );
}
