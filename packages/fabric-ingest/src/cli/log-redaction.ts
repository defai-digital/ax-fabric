/**
 * Log redaction — ensures tokens and secrets never appear in log output.
 *
 * ADR-007: all log sinks MUST pass through `redact()` before emitting.
 */

// ─── Redaction patterns ──────────────────────────────────────────────────────

const REDACT_PLACEHOLDER = "***REDACTED***";

const REDACT_PATTERNS: RegExp[] = [
  // Matches:  Bearer <token>  (must run before the keyword pattern)
  /Bearer\s+([^\s"']+)/gi,
  // Matches:  token: "value"  |  api_key = value  |  secret: 'value'  etc.
  /(?:token|api_key|secret|password|authorization)\s*[:=]\s*["']?([^\s"',}]+)/gi,
  // Matches JSON-serialised keys:  "token":"value"  |  "api_key":"value"
  /"(?:token|api_key|secret|password)"\s*:\s*"([^"]+)"/gi,
];

/**
 * Replace secret values captured by `REDACT_PATTERNS` with the
 * `***REDACTED***` placeholder.
 */
export function redact(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    // Reset lastIndex — the regex has the global flag.
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, captured: string) =>
      match.replace(captured, REDACT_PLACEHOLDER),
    );
  }
  return result;
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

/** Stringify an argument so it can be passed through `redact()`. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Create a prefixed logger that redacts every message before printing.
 *
 * ```ts
 * const log = createLogger("ingest");
 * log.info("using token: sk-abc123");
 * // => [ingest] using token: ***REDACTED***
 * ```
 */
export function createLogger(prefix: string): Logger {
  function format(msg: string, args: unknown[]): string {
    const parts = [msg, ...args.map(stringify)].join(" ");
    return redact(`[${prefix}] ${parts}`);
  }

  return {
    info(msg: string, ...args: unknown[]): void {
      console.log(format(msg, args));
    },
    error(msg: string, ...args: unknown[]): void {
      console.error(format(msg, args));
    },
    warn(msg: string, ...args: unknown[]): void {
      console.warn(format(msg, args));
    },
  };
}
