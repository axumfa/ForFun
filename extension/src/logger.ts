/** Structured (JSON-lines) logging to a sink; the sink is injected so core logic stays free of VS Code. */
export type Level = "debug" | "info" | "warn" | "error";
export interface Sink { appendLine(line: string): void; }
export class Logger {
  private readonly sink: Sink;
  constructor(sink: Sink) { this.sink = sink; }
  log(level: Level, event: string, data: Record<string, unknown> = {}): void {
    this.sink.appendLine(JSON.stringify({ t: new Date().toISOString(), level, event, ...data }));
  }
  info(event: string, data?: Record<string, unknown>): void { this.log("info", event, data); }
  warn(event: string, data?: Record<string, unknown>): void { this.log("warn", event, data); }
  error(event: string, data?: Record<string, unknown>): void { this.log("error", event, data); }
}
