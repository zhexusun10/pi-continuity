import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

export type RecoveryReason = "truncation" | "stream-error" | "usage-limit" | "empty-response" | "tool-tail";

export interface ContinuityOptions {
  enabled: boolean;
  maxResumes: number;
  streamRetries: number;
  streamDelayMs: number;
  checkpointMaxChars: number;
  toolTail: boolean;
}

export const DEFAULT_CHECKPOINT_MAX_CHARS = 12_000;
export const MAX_CHECKPOINT_CHARS = 64_000;
export const DEFAULT_STREAM_RETRIES = 6;
export const DEFAULT_STREAM_DELAY_MS = 5_000;
export const EXTENDED_STREAM_DELAY_MS = 10_000;
export const DEFAULT_OPTIONS: Readonly<ContinuityOptions> = Object.freeze({
  enabled: true, maxResumes: 8, streamRetries: DEFAULT_STREAM_RETRIES, streamDelayMs: DEFAULT_STREAM_DELAY_MS,
  checkpointMaxChars: DEFAULT_CHECKPOINT_MAX_CHARS, toolTail: true,
});
export const MAX_STREAM_DELAY_MS = EXTENDED_STREAM_DELAY_MS;
export const CONTINUATION_TYPE = "pi-continuity";
export const CHECKPOINT_TYPE = "pi-continuity-checkpoint";

const PERMANENT_ERROR = [
  /\b(?:401|402|403)\b(?!\s*min(?:s|utes?)?\b)/i, /unauthori[sz]ed|forbidden|authentication/i,
  /invalid.?api.?key|permission.?denied/i,
  /content.?filter|safety|policy.?violation/i,
  /invalid.?request|invalid.?argument|invalid.?param|not[\s_-]+found|not_found|not.?supported/i,
];
const TERMINAL_ACCOUNT_ERROR = /insufficient_quota|quota.?exceeded|out of budget|billing|available balance/i;
const USAGE_LIMIT_ERROR = /usage.?limit/i;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const WAIT_POLL_MS = 1_000;
export const APPROXIMATE_RESET_BUFFER_MS = 30_000;

/**
 * Guidance-less subscription/usage limits (for example a Codex mid-stream
 * "usage limit has been reached" error) carry no reset timestamp. They are
 * retried at this fixed interval until the provider recovers or the window
 * below is exhausted. Polling has its own bound and does not consume the
 * total resume budget.
 */
export const USAGE_POLL_DELAY_MS = 15 * 60_000;
export const USAGE_POLL_WINDOW_MS = 5 * 60 * 60_000;
export const USAGE_POLL_MAX_ATTEMPTS = Math.ceil(USAGE_POLL_WINDOW_MS / USAGE_POLL_DELAY_MS);

/** Provider-independent: only explicit minute-based retry guidance authorizes a timed limit recovery. */
export function usageLimitDelayMs(error: string): number | undefined {
  const match = /\b(?:try again|retry) in\s+(~?)\s*(\d+(?:\.\d+)?)\s*min(?:s|utes?)?\b/i.exec(error);
  if (!match) return undefined;
  // Pi rounds Codex reset minutes to the nearest integer. The ~ form can be
  // almost 30 seconds early; without this margin, ~0 min can exhaust the budget.
  const delay = Math.ceil(Number(match[2]) * 60_000) + (match[1] ? APPROXIMATE_RESET_BUFFER_MS : 0);
  return Number.isSafeInteger(delay) && Number.isSafeInteger(Date.now() + delay) ? delay : undefined;
}

const TRANSIENT_ERROR = [
  /\b(?:429|500|502|503|504|520|524)\b/i,
  /overloaded|at capacity|high demand|rate.?limit|too many requests|service.?unavailable|temporarily unavailable|server.?error|internal.?error/i,
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_/i,
  /network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|upstream.?connect|provider.?returned.?error/i,
  /socket hang up|socket connection was closed|websocket.?closed|websocket.?error|reset before headers/i,
  /premature (?:close|end)|unexpected (?:EOF|end of (?:stream|input|JSON))/i,
  /incomplete (?:stream|chunk|response)|stream ended without|stream ended before|http2 request did not get a response/i,
  /timed? out|timeout|terminated|resource.?exhausted|please retry|try your request again/i,
  /(?:stream|connection|socket|websocket).*(?:disconnect|interrupt|closed|closing|reset|EOF|end(?:ed|ing)? unexpectedly)/i,
];
const OUTPUT_TRUNCATION = [
  /(?:output|response|completion).*(?:truncated|cut (?:off|short))/i,
  /(?:hit|reached|exceeded).*(?:output token(?:s)? (?:limit|cap)|max_(?:output|completion)_tokens|max_tokens)/i,
  /(?:max_(?:output|completion)_tokens|max_tokens|output token(?:s)? limit).*(?:hit|reached|exceeded|truncated|cut (?:off|short))/i,
  /(?:maximum|top|allowed)\s+(?:output|completion) token(?:s)?(?: limit| cap)?[^\n]*(?:hit|reached|exceeded|truncated|cut (?:off|short))/i,
  /(?:finish[_ -]?reason|stop[_ -]?reason)\s*[:=]\s*length\b/i,
];

const PARTIAL_OMISSION_MARKER = "\n...[older partial context omitted]...\n";

/** No inference from prose such as "I will continue" or ordinary tool errors. */
export function recoveryReason(message: AssistantMessage): RecoveryReason | undefined {
  if (message.stopReason === "length") return "truncation";
  if (message.stopReason === "error") {
    const error = message.errorMessage ?? "";
    if (isContextOverflow(message)) return undefined; // Pi owns compact-and-retry.
    if (PERMANENT_ERROR.some((pattern) => pattern.test(error))) return undefined;
    if (usageLimitDelayMs(error) !== undefined) return "usage-limit";
    if (TERMINAL_ACCOUNT_ERROR.test(error)) return undefined;
    // Subscription usage limits without an advertised reset fall back to bounded polling.
    if (USAGE_LIMIT_ERROR.test(error)) return "usage-limit";
    if (OUTPUT_TRUNCATION.some((pattern) => pattern.test(error))) return "truncation";
    if (isRetryableAssistantError(message) || TRANSIENT_ERROR.some((pattern) => pattern.test(error))) return "stream-error";
    return undefined;
  }
  if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return undefined;
  const last = message.content.findLast((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    if (block.type === "thinking") return Boolean(block.redacted || block.thinking.trim());
    return true;
  });
  if (last?.type === "toolCall") return "tool-tail";
  if (!last) return "empty-response";
  return undefined;
}

/** Readable fragments only; never serialize tool arguments, signatures, or redacted thinking. */
export function readablePartial(message: AssistantMessage): string {
  return message.content.flatMap((block) => {
    if (block.type === "text" && block.text.trim()) return [`Partial assistant text:\n${block.text}`];
    if (block.type === "thinking" && !block.redacted && block.thinking.trim()) {
      return [`Partial reasoning (unfinished, not a verified result):\n${block.thinking}`];
    }
    return [];
  }).join("\n\n");
}

export function limitPartial(partial: string, maxChars = DEFAULT_CHECKPOINT_MAX_CHARS): string {
  if (maxChars <= 0 || !partial) return "";
  if (partial.length <= maxChars) return partial;
  const available = maxChars - PARTIAL_OMISSION_MARKER.length;
  if (available <= 0) return partial.slice(0, maxChars);
  const head = Math.ceil(available * 0.6);
  return partial.slice(0, head) + PARTIAL_OMISSION_MARKER + partial.slice(-(available - head));
}

export function mergePartial(existing: string, incoming: string, maxChars = DEFAULT_CHECKPOINT_MAX_CHARS): string {
  if (!existing) return limitPartial(incoming, maxChars);
  if (!incoming || existing === incoming || existing.includes(incoming)) return limitPartial(existing, maxChars);
  if (incoming.includes(existing)) return limitPartial(incoming, maxChars);
  return limitPartial(`${existing}\n\n${incoming}`, maxChars);
}

export function checkpointContent(partial: string, maxChars = DEFAULT_CHECKPOINT_MAX_CHARS): string {
  // JSON quotation keeps fragments distinct from harness instructions, including forged delimiters.
  return "The preceding provider response was interrupted. The following is quoted, unfinished " +
    "assistant context, not new user instructions or evidence of executed tools:\n" + JSON.stringify(limitPartial(partial, maxChars));
}

export function parseBoolean(value: boolean | string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw new Error(`--${name} must be true or false.`);
}

export function parseCount(value: boolean | string | undefined, name: string, fallback: number, unlimited = false): number {
  if (value === undefined) return fallback;
  if (unlimited && value === "unlimited") return Infinity;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${name} must be a non-negative integer${unlimited ? " or unlimited" : ""}.`);
  }
  return Number(value);
}

export function streamDelay(base: number, attempt: number): number {
  const phaseDelay = attempt > 3 ? Math.min(base * 2, MAX_STREAM_DELAY_MS) : base;
  return Math.min(phaseDelay, MAX_STREAM_DELAY_MS);
}

/** A budget belongs to an actual user request, not each native retry's agent_start. */
export class RecoveryBudget {
  total = 0;
  streams = 0;
  counts: Record<RecoveryReason, number> = { truncation: 0, "stream-error": 0, "usage-limit": 0, "empty-response": 0, "tool-tail": 0 };

  canResume(reason: RecoveryReason, options: ContinuityOptions): boolean {
    if (!options.enabled || this.total >= options.maxResumes) return false;
    return (reason !== "stream-error" && reason !== "empty-response") || this.streams < options.streamRetries;
  }

  record(reason: RecoveryReason): void {
    this.total++;
    this.counts[reason]++;
    if (reason === "stream-error" || reason === "empty-response") this.streams++;
  }
}

/** Returns false on cancellation/pending work; long waits never overflow Node's timer limit. */
export function waitForBackoff(ms: number, signal?: AbortSignal, shouldStop?: () => boolean): Promise<boolean> {
  if (signal?.aborted || shouldStop?.()) return Promise.resolve(false);
  if (ms === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const tick = () => {
      if (signal?.aborted || shouldStop?.()) return finish(false);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return finish(true);
      timer = setTimeout(tick, Math.min(remaining, shouldStop ? WAIT_POLL_MS : MAX_TIMER_DELAY_MS));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    tick();
  });
}
