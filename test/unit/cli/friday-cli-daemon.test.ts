import { describe, it, expect } from "vitest";
import { parseArgs } from "#cli";

describe("parseArgs — daemon command", () => {
  const argv = (...args: string[]) => ["node", "friday-cli.js", ...args];

  it("parses 'daemon' as command", () => {
    const result = parseArgs(argv("daemon"));
    expect(result.command).toBe("daemon");
  });

  it("parses 'daemon start' subcommand", () => {
    const result = parseArgs(argv("daemon", "start"));
    expect(result.command).toBe("daemon");
    expect(result.daemonSubcommand).toBe("start");
  });

  it("parses 'daemon stop' subcommand", () => {
    const result = parseArgs(argv("daemon", "stop"));
    expect(result.command).toBe("daemon");
    expect(result.daemonSubcommand).toBe("stop");
  });

  it("parses 'daemon restart' subcommand", () => {
    const result = parseArgs(argv("daemon", "restart"));
    expect(result.command).toBe("daemon");
    expect(result.daemonSubcommand).toBe("restart");
  });

  it("parses 'daemon status' subcommand", () => {
    const result = parseArgs(argv("daemon", "status"));
    expect(result.command).toBe("daemon");
    expect(result.daemonSubcommand).toBe("status");
  });

  it("leaves daemonSubcommand undefined for bare 'daemon'", () => {
    const result = parseArgs(argv("daemon"));
    expect(result.command).toBe("daemon");
    expect(result.daemonSubcommand).toBeUndefined();
  });

  it("leaves daemonSubcommand undefined for unknown sub", () => {
    const result = parseArgs(argv("daemon", "foo"));
    expect(result.command).toBe("daemon");
    expect(result.daemonSubcommand).toBeUndefined();
  });
});
