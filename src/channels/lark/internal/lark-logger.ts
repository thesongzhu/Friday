/**
 * Minimal logger proxy for the native Lark WS client.
 *
 * Mirrors the level semantics of `@larksuiteoapi/node-sdk` (MIT, around line
 * 87240–87280 of `es/index.js`) so call sites that previously passed
 * `Lark.LoggerLevel.warn` continue to behave the same — only messages at or
 * below the configured level are emitted.
 */

export type LarkLoggerLevelName = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_NUMERIC: Record<LarkLoggerLevelName, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export interface LarkLogger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}

const DEFAULT_LARK_LOGGER: LarkLogger = {
  error: (...a) => { console.error(...a); },
  warn: (...a) => { console.warn(...a); },
  info: (...a) => { console.info(...a); },
  debug: (...a) => { console.debug(...a); },
  trace: (...a) => { console.debug(...a); },
};

export class LarkLoggerProxy implements LarkLogger {
  private readonly level: number;
  private readonly target: LarkLogger;

  constructor(level: LarkLoggerLevelName | number = "warn", target: LarkLogger = DEFAULT_LARK_LOGGER) {
    this.level = typeof level === "number" ? level : LEVEL_NUMERIC[level];
    this.target = target;
  }

  error(...args: unknown[]): void {
    if (this.level >= LEVEL_NUMERIC.error) this.target.error(...args);
  }
  warn(...args: unknown[]): void {
    if (this.level >= LEVEL_NUMERIC.warn) this.target.warn(...args);
  }
  info(...args: unknown[]): void {
    if (this.level >= LEVEL_NUMERIC.info) this.target.info(...args);
  }
  debug(...args: unknown[]): void {
    if (this.level >= LEVEL_NUMERIC.debug) this.target.debug(...args);
  }
  trace(...args: unknown[]): void {
    if (this.level >= LEVEL_NUMERIC.trace) this.target.trace(...args);
  }
}
