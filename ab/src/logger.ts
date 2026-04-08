/**
 * Structured JSON logger for the ab-server daemon.
 * Writes to stderr so stdout stays clean for RPC responses.
 *
 * Automatically includes `opId` from the current async context when available,
 * so all log lines within an operation can be correlated.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogComponent = "daemon" | "chrome" | "auth" | "cli";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: LogComponent;
  msg: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  component: LogComponent;
}

// ---------------------------------------------------------------------------
// Operation context — propagates opId through async call chains
// ---------------------------------------------------------------------------

interface OpContext {
  opId: string;
}

const opContextStorage = new AsyncLocalStorage<OpContext>();

/** Run `fn` with a correlation ID that appears in all log lines within the scope. */
export function withOpId<T>(opId: string, fn: () => T | Promise<T>): T | Promise<T> {
  return opContextStorage.run({ opId }, fn);
}

/** Generate a short random operation ID. */
export function newOpId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  private minLevel: number;
  private component: LogComponent;

  constructor(opts: LoggerOptions) {
    this.minLevel = LEVEL_ORDER[opts.minLevel ?? "info"];
    this.component = opts.component;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  private log(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const ctx = opContextStorage.getStore();
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...(ctx ? { opId: ctx.opId } : {}),
      ...data,
    };

    Bun.write(Bun.stderr, JSON.stringify(entry) + "\n");
  }
}
