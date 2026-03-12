using System.Text.Json;

var payload = new
{
  runtime = "windows_companion_scaffold",
  platform = Environment.OSVersion.Platform.ToString(),
  socketPath = Environment.GetEnvironmentVariable("FRIDAY_SYSTEM_COMPANION_SOCKET_PATH"),
  authTokenFile = Environment.GetEnvironmentVariable("FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE"),
  heartbeatIntervalMs = Environment.GetEnvironmentVariable("FRIDAY_SYSTEM_COMPANION_HEARTBEAT_MS"),
};

Console.WriteLine(JsonSerializer.Serialize(payload));
