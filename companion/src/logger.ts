export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export interface CompanionLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LogSink {
  write(line: string): void;
}

// `history`, `turn`, and `answer` cover the opt-in conversation payload, which
// carries player-authored text and must never reach the log.
const SENSITIVE_FIELD =
  /(?:api.?key|authorization|answer|context|history|prompt|question|secret|state|token|turns?)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
];

export class JsonLogger implements CompanionLogger {
  readonly #sink: LogSink;
  readonly #now: () => Date;

  public constructor(
    sink: LogSink = { write: (line) => console.log(line) },
    now: () => Date = () => new Date(),
  ) {
    this.#sink = sink;
    this.#now = now;
  }

  public info(event: string, fields: LogFields = {}): void {
    this.#log("info", event, fields);
  }

  public warn(event: string, fields: LogFields = {}): void {
    this.#log("warn", event, fields);
  }

  public error(event: string, fields: LogFields = {}): void {
    this.#log("error", event, fields);
  }

  #log(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
    const safeFields: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      safeFields[key] = SENSITIVE_FIELD.test(key)
        ? "[REDACTED]"
        : typeof value === "string"
          ? redactSecrets(value)
          : value;
    }

    this.#sink.write(
      JSON.stringify({
        timestamp: this.#now().toISOString(),
        level,
        event: redactSecrets(event),
        ...safeFields,
      }),
    );
  }
}

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}
