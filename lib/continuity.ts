import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { retryDelayMs } from "./retry-delay.ts";

export { APPROXIMATE_RESET_BUFFER_MS, formatDelayMs, retryDelayMs } from "./retry-delay.ts";

export type RecoveryReason = "truncation" | "stream-error" | "unknown-error" | "usage-limit" | "empty-response" | "tool-tail";

export interface ContinuityOptions {
  enabled: boolean;
  maxResumes: number;
  streamRetries: number;
  unknownRetries: number;
  streamDelayMs: number;
  /** @deprecated Retained for option compatibility; checkpoint text is never injected. */
  checkpointMaxChars: number;
  toolTail: boolean;
}

/** @deprecated Retained for API/CLI compatibility; checkpoint text is never injected. */
export const DEFAULT_CHECKPOINT_MAX_CHARS = 12_000;
/** @deprecated Retained for CLI validation compatibility; checkpoint text is never injected. */
export const MAX_CHECKPOINT_CHARS = 64_000;
export const DEFAULT_STREAM_RETRIES = 12;
export const DEFAULT_UNKNOWN_RETRIES = 2;
export const DEFAULT_STREAM_DELAY_MS = 5_000;
export const EXTENDED_STREAM_DELAY_MS = 10_000;
export const DEFAULT_OPTIONS: Readonly<ContinuityOptions> = Object.freeze({
  enabled: true, maxResumes: 16, streamRetries: DEFAULT_STREAM_RETRIES, unknownRetries: DEFAULT_UNKNOWN_RETRIES,
  streamDelayMs: DEFAULT_STREAM_DELAY_MS,
  checkpointMaxChars: DEFAULT_CHECKPOINT_MAX_CHARS, toolTail: true,
});
export const MAX_STREAM_DELAY_MS = EXTENDED_STREAM_DELAY_MS;
export const CONTINUATION_TYPE = "pi-continuity";
export const CHECKPOINT_TYPE = "pi-continuity-checkpoint";

const PERMANENT_HTTP_STATUS = new Set([401, 402, 403, 404, 405, 407, 410, 413, 415, 422, 451, 501, 505]);

/** SDK prefixes or explicit status fields only, not request IDs, byte counts, or reset minutes. */
function httpErrorStatus(error: string): number | undefined {
  const match = /^(?:(?:[a-z]*Error|HTTP(?:\/[\d.]+)?)[:\s]+)*([45]\d{2})(?=\s|[;:,)\]}]|$)/i.exec(error) ??
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?(?:[\s_-]+(?:error|status))?|status(?:[\s_-]*code)?|httpStatusCode)["']?\s*[:=(]?\s*["']?([45]\d{2})\b/i.exec(error) ??
    /\b(?:API|provider) error\s*(?:\(\s*|:\s*)([45]\d{2})\b/i.exec(error);
  return match ? Number(match[1]) : undefined;
}

const PERMANENT_ERROR = [
  /unauthori[sz]ed|forbidden|authentication/i,
  /(?:invalid|missing|no)[\s_-]*(?:api[\s_-]*)?key\b|permission.?denied/i,
  /(?:access[\s_-]*|refresh[\s_-]*|auth[\s_-]*)token[\s_-]*(?:has[\s_-]*)?(?:expired|invalid|revoked)/i,
  /(?:expired|invalid|revoked)[\s_-]*(?:access|refresh|auth)[\s_-]*token/i,
  /(?:please|must|need to)\s+(?:log[ -]?in|sign[ -]?in)|login.?required|session.?expired/i,
  /content.?filter|safety|policy.?violation/i,
  /invalid.?request|invalid.?argument|invalid.?param|not[\s_-]+found|not_found|not.?supported/i,
  /missing[\s_-]+(?:required[\s_-]+)?(?:param(?:eter)?|field)|unsupported[\s_-]+(?:param(?:eter)?|model|media|value|role)/i,
  /invalid[\s_-]+(?:max_(?:output_|completion_)?tokens|temperature|top_p|model|schema|tool|role)\b/i,
  /unprocessable[\s_-]+(?:entity|content)|validation[\s_-]+(?:error|failed)|malformed[\s_-]+(?:request|payload)/i,
  // A finalized error is not permission to retry explicit cancellation or local programming bugs.
  /\bAbortError\b/i,
  /^(?:(?:Error|TypeError):\s*)?(?:aborted|cancelled|canceled)[.!]?$/i,
  /\buser[\s_-]+(?:cancel(?:led|ed)|aborted)\b|\b(?:cancel(?:led|ed)|aborted) by (?:the )?user\b/i,
  /\b(?:request|operation) (?:was )?(?:aborted|cancel(?:led|ed))\b(?! by (?:the )?(?:server|upstream|peer))/i,
  /\b(?:TypeError:.*(?:cannot read|cannot set|is not a function)|ReferenceError:)/i,
  // Certificate validation is deterministic even when wrapped as "TLS handshake
  // failed: ...": retrying the same request against the same expired or untrusted
  // certificate cannot succeed. Checked before the broad TLS/network transient
  // patterns so it does not trigger paid retries.
  /certificate[\s\S]{0,80}?\b(?:expired|not yet valid|revoked|untrusted|self.?signed|unknown authority|altname|hostname mismatch)/i,
  /(?:self.?signed|untrusted) certificate/i,
  /unable to verify (?:the )?(?:first|leaf|server) certificate/i,
  /certificate.?verify.?failed/i,
  /hostname\/ip does not match certificate/i,
  /\b(?:CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_REVOKED|CERT_UNTRUSTED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)\b/,
  /\bx509:/i,
];
const TERMINAL_ACCOUNT_ERROR = /insufficient_quota|quota.?exceeded|out of budget|billing|available balance/i;
const USAGE_LIMIT_ERROR = /usage.?limit/i;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const WAIT_POLL_MS = 1_000;

/**
 * Guidance-less subscription/usage limits (for example a Codex mid-stream
 * "usage limit has been reached" error) carry no reset timestamp. They are
 * retried at this fixed interval until the provider recovers or the window
 * below is exhausted. Polling has its own bound and does not consume the
 * total resume budget.
 *
 * A provider's usage window is commonly 5 h. The first window waits exactly
 * that long. Once a window has been exhausted (the extension gave up), later
 * windows add a buffer so the poll does not stop at the same instant the
 * provider resets.
 */
export const USAGE_POLL_DELAY_MS = 10 * 60_000;
export const USAGE_POLL_WINDOW_MS = 5 * 60 * 60_000;
export const EXTENDED_USAGE_POLL_WINDOW_MS = USAGE_POLL_WINDOW_MS + 20 * 60_000;
export const USAGE_POLL_MAX_ATTEMPTS = Math.ceil(USAGE_POLL_WINDOW_MS / USAGE_POLL_DELAY_MS);
export const EXTENDED_USAGE_POLL_MAX_ATTEMPTS = Math.ceil(EXTENDED_USAGE_POLL_WINDOW_MS / USAGE_POLL_DELAY_MS);

/** Backwards-compatible name for provider-independent explicit retry guidance. */
export function usageLimitDelayMs(error: string): number | undefined {
  return retryDelayMs(error);
}

const TRANSIENT_ERROR = [
  /overloaded|at capacity|high demand|rate.?limit|too many requests|service.?unavailable|temporarily unavailable|server.?error|internal.?error/i,
  /bad gateway|gateway timeout|temporarily overloaded|engine overloaded|system is busy|model is busy|server is busy/i,
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_|ERR_HTTP2_|ERR_STREAM_|ERR_NETWORK_CHANGED/i,
  /network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|failed to fetch|network request failed|upstream.?connect|provider.?returned.?error/i,
  /client network socket disconnected|peer connection was lost|connection reset by peer/i,
  /tls (?:handshake )?(?:timeout|error|failed)|ssl (?:handshake )?(?:timeout|error|failed)/i,
  /socket hang up|socket connection was closed|websocket.?closed|websocket.?error|reset before headers/i,
  /premature (?:close|end)|unexpected (?:EOF|end of (?:stream|input|JSON))/i,
  /incomplete (?:stream|chunk|response)|stream ended without|stream ended before|http2 request did not get a response/i,
  /no response body|empty response body/i,
  // Bare "stream error" wrappers (for example Go HTTP/2 relays reporting
  // "stream error: stream ID 1; PROTOCOL_ERROR; received from peer", or a
  // proxy's "Stream error occurred") carry no status code. Permanent/auth/
  // overflow/usage checks run first, so a terminal cause with this prefix is
  // still excluded.
  /\bstream error\b/i,
  /RST_STREAM|GOAWAY|PROTOCOL_ERROR|aborted by the (?:server|upstream)/i,
  /\b(?:stream|request|connection).*cancel(?:led|ed) by (?:the )?(?:server|upstream|peer)/i,
  /timed? out|timeout|terminated|resource.?exhausted|please retry|try your request again/i,
  /(?:stream|connection|socket|websocket).*(?:disconnect|interrupt|closed|closing|reset|EOF|end(?:ed|ing)? unexpectedly)/i,
];
const OUTPUT_TRUNCATION = [
  /(?:output|response|completion).*(?:truncated|cut (?:off|short))/i,
  /(?:hit|reached|exceeded).*(?:output token(?:s)? (?:limit|cap)|max_(?:output|completion)_tokens|max_tokens)/i,
  /(?:max_(?:output|completion)_tokens|max_tokens|output token(?:s)? limit).*(?:hit|reached|exceeded|truncated|cut (?:off|short))/i,
  /(?:maximum|top|allowed|max)\s+(?:output|completion)?\s*token(?:s)?(?: limit| cap)?[^\n]*(?:hit|reached|exceeded|truncated|cut (?:off|short))/i,
  /(?:finish[_ -]?reason|stop[_ -]?reason)\s*[:=]\s*(?:length|max_tokens)\b/i,
];

/** No inference from prose such as "I will continue" or ordinary tool errors. */
export function recoveryReason(message: AssistantMessage): RecoveryReason | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (message.stopReason === "length") return "truncation";
  if (message.stopReason === "error") {
    const error = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
    if (isContextOverflow(message)) return undefined; // Pi owns compact-and-retry.
    const status = httpErrorStatus(error);
    if ((status !== undefined && PERMANENT_HTTP_STATUS.has(status)) ||
      PERMANENT_ERROR.some((pattern) => pattern.test(error))) return undefined;
    if (retryDelayMs(error) !== undefined) return "usage-limit";
    if (TERMINAL_ACCOUNT_ERROR.test(error)) return undefined;
    // Subscription usage limits without an advertised reset fall back to bounded polling.
    if (USAGE_LIMIT_ERROR.test(error)) return "usage-limit";
    if (OUTPUT_TRUNCATION.some((pattern) => pattern.test(error))) return "truncation";
    if ((status !== undefined && ([408, 409, 425, 429].includes(status) || status >= 500)) ||
      isRetryableAssistantError(message) || TRANSIENT_ERROR.some((pattern) => pattern.test(error))) return "stream-error";
    // A generic 400/Bad Request, missing diagnostic, or new provider wording is
    // not proof of a permanent cause. Give it a smaller, separate retry cap;
    // never pretend it is a known transient failure or rewrite raw history.
    return "unknown-error";
  }
  if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return undefined;
  if (!Array.isArray(message.content)) return "empty-response";
  const last = message.content.findLast((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    if (block.type === "thinking") return Boolean(block.redacted || (typeof block.thinking === "string" && block.thinking.trim()));
    return true;
  });
  if (last?.type === "toolCall") return "tool-tail";
  if (!last || (last.type === "thinking" && !message.content.some((block) =>
    block && typeof block === "object" && (block.type === "toolCall" ||
      (block.type === "text" && typeof block.text === "string" && block.text.trim()))))) return "empty-response";
  return undefined;
}

const PARTIAL_OMISSION_MARKER = "\n...[older partial context omitted]...\n";

/** @deprecated Retained for API compatibility; the extension never injects this content. */
export function readablePartial(message: AssistantMessage): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return [`Partial assistant text:\n${block.text}`];
    }
    if (block.type === "thinking" && !block.redacted && typeof block.thinking === "string" && block.thinking.trim()) {
      return [`Partial reasoning (unfinished, not a verified result):\n${block.thinking}`];
    }
    return [];
  }).join("\n\n");
}

/** @deprecated Retained for API compatibility; the extension never injects this content. */
export function limitPartial(partial: string, maxChars = DEFAULT_CHECKPOINT_MAX_CHARS): string {
  if (typeof maxChars !== "number" || !Number.isFinite(maxChars) || maxChars <= 0 || !partial) return "";
  if (partial.length <= maxChars) return partial;
  const available = maxChars - PARTIAL_OMISSION_MARKER.length;
  if (available <= 0) return partial.slice(0, maxChars);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return partial.slice(0, head) + PARTIAL_OMISSION_MARKER + (tail > 0 ? partial.slice(-tail) : "");
}

/** @deprecated Retained for API compatibility; the extension never injects this content. */
export function mergePartial(existing: string, incoming: string, maxChars = DEFAULT_CHECKPOINT_MAX_CHARS): string {
  if (!existing) return limitPartial(incoming, maxChars);
  if (!incoming || existing === incoming || existing.includes(incoming)) return limitPartial(existing, maxChars);
  if (incoming.includes(existing)) return limitPartial(incoming, maxChars);
  return limitPartial(`${existing}\n\n${incoming}`, maxChars);
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
  const safeBase = typeof base === "number" && Number.isFinite(base) && base > 0 ? base : 0;
  const phaseDelay = attempt > 3 ? Math.min(safeBase * 2, MAX_STREAM_DELAY_MS) : safeBase;
  return Math.min(phaseDelay, MAX_STREAM_DELAY_MS);
}

/** All short fallbacks share the existing stream and total spending limits. */
export function usesStreamBudget(reason: RecoveryReason): boolean {
  return reason === "stream-error" || reason === "empty-response" || reason === "unknown-error";
}

/** A budget belongs to an actual user request, not each native retry's agent_start. */
export class RecoveryBudget {
  total = 0;
  streams = 0;
  counts: Record<RecoveryReason, number> = {
    truncation: 0, "stream-error": 0, "unknown-error": 0, "usage-limit": 0, "empty-response": 0, "tool-tail": 0,
  };

  canResume(reason: RecoveryReason, options: ContinuityOptions): boolean {
    if (!options.enabled || this.total >= options.maxResumes) return false;
    if (reason === "unknown-error" && this.counts[reason] >= options.unknownRetries) return false;
    return !usesStreamBudget(reason) || this.streams < options.streamRetries;
  }

  record(reason: RecoveryReason): void {
    this.total++;
    this.counts[reason]++;
    if (usesStreamBudget(reason)) this.streams++;
  }
}

/** Returns false on cancellation/pending work; long waits never overflow Node's timer limit. */
export function waitForBackoff(ms: number, signal?: AbortSignal, shouldStop?: () => boolean): Promise<boolean> {
  if (signal?.aborted || shouldStop?.()) return Promise.resolve(false);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(true);
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
