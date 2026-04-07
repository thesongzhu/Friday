import { spawnSync } from "node:child_process";

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number") {
    if (result.status !== 0) {
      process.exit(result.status);
    }
    return;
  }

  process.exit(1);
}

runCommand("npm", ["run", "build:ui"]);
runCommand("npx", ["vitest", "run", "--project", "browser-e2e", ...process.argv.slice(2)]);
