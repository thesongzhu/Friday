/**
 * Sample plugin entrypoint template.
 * Replace with actual plugin lifecycle hooks.
 */
export function createPlugin() {
  return {
    id: "com.example.channel.demo",
    start() {
      return { ok: true };
    },
    stop() {
      return { ok: true };
    },
  };
}
