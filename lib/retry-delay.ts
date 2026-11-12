export const APPROXIMATE_RESET_BUFFER_MS = 30_000;

const UNIT_GROUPS: readonly (readonly [number, readonly string[]])[] = [
  [1, ["ms", "msec", "msecs", "millisecond", "milliseconds"]],
  [1_000, ["s", "sec", "secs", "second", "seconds"]],
  [60_000, ["m", "min", "mins", "minute", "minutes", "miute", "miutes", "minuite", "minuites", "mintue", "mintues"]],
  [3_600_000, ["h", "hr", "hrs", "hour", "hours"]],
  [86_400_000, ["d", "day", "days"]],
];
const UNIT_MS = new Map(UNIT_GROUPS.flatMap(([factor, names]) => names.map((name): [string, number] => [name, factor])));
const DECIMAL = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const UNIT_PATTERN = [...UNIT_MS.keys()].sort((a, b) => b.length - a.length).join("|");
const DURATION_PART = new RegExp(`^(${DECIMAL})\\s*(${UNIT_PATTERN})(?![a-z_])`, "i");
// A number is meaningful only after explicit retry/reset/wait guidance. Keys
// permit snake_case, kebab-case and camelCase; bare cooldown numbers have no unit.
const HINT_KEY = String.raw`(?:cool[\s_-]?down|retry[\s_-]?after|retry[\s_-]?delay)(?:[\s_-]?(?:${UNIT_PATTERN}))?`;
const RETRY_HINT = new RegExp(String.raw`\b((?:try again|retry(?:ing)?)\s+(?:in|after)|(?:please\s+)?wait(?:\s+for)?|resets?\s+in|${HINT_KEY})(?:["']?\s*[:=：]\s*["']?|\s+)`, "gi");
const APPROXIMATION = /^(?:[~≈]\s*|(?:about|approximately|approx\.?)\s+)/i;
const NUMBER_VALUE = new RegExp(`^(${DECIMAL})(?=[ \\t]*(?:$|["'},;\\]]|\\r?\\n))`);
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT\b/i;

function safeDelay(ms: number, now: number): number | undefined {
  const rounded = Math.ceil(ms);
  return rounded >= 0 && Number.isSafeInteger(rounded) && Number.isSafeInteger(now + rounded) ? rounded : undefined;
}

function durationMs(value: string): number | undefined {
  const approximate = APPROXIMATION.exec(value);
  let rest = approximate ? value.slice(approximate[0].length) : value;
  let total = 0;
  let smallestUnit = Infinity;
  for (;;) {
    const part = DURATION_PART.exec(rest);
    if (!part) return undefined; // Do not accept a valid prefix of a malformed compound.
    const factor = UNIT_MS.get(part[2]!.toLowerCase());
    if (factor === undefined) return undefined;
    total += Number(part[1]) * factor;
    if (!Number.isFinite(total)) return undefined;
    smallestUnit = Math.min(smallestUnit, factor);
    rest = rest.slice(part[0].length).replace(/^\s*(?:,\s*)?(?:and\s+)?/i, "");
    if (/^(?:[+\-/]?\s*(?:\d|\.\d)|NaN|Infinity)/i.test(rest)) continue;
    // The ~ minute form retains its existing 30-second rounding margin.
    // Other units get half the smallest advertised unit, rounded up to 1 ms.
    return total + (approximate ? Math.ceil(smallestUnit / 2) : 0);
  }
}

/**
 * Parse explicit provider retry guidance, not arbitrary numbers in error text.
 * Multiple valid hints use the longest delay to avoid an early retry. Dates are
 * accepted only as RFC-style Retry-After HTTP dates, never guessed by Date.parse.
 */
export function retryDelayMs(error: string, now = Date.now()): number | undefined {
  if (!Number.isSafeInteger(now)) return undefined;
  let longest: number | undefined;
  // matchAll clones the global regexp so nested/repeated calls do not share a cursor.
  for (const hint of error.matchAll(RETRY_HINT)) {
    const value = error.slice(hint.index + hint[0].length).trimStart().replace(/^(?:is|for|in)\s+/i, "");
    const key = hint[1]!.toLowerCase().replace(/[\s_-]/g, "");
    const header = key === "retryafter" && /[:=：]/.test(hint[0]);
    let delay = durationMs(value);
    if (delay === undefined && header) {
      const date = HTTP_DATE.exec(value);
      if (date) delay = Math.max(0, Date.parse(date[0]) - now);
    }
    if (delay === undefined) {
      const numeric = NUMBER_VALUE.exec(value);
      const suffix = /^(?:cooldown|retryafter|retrydelay)([a-z]+)$/.exec(key)?.[1];
      const factor = suffix ? UNIT_MS.get(suffix) : header ? 1_000 : undefined;
      if (numeric && factor !== undefined) delay = Number(numeric[1]) * factor;
    }
    const safe = delay === undefined ? undefined : safeDelay(delay, now);
    if (safe !== undefined) longest = longest === undefined ? safe : Math.max(longest, safe);
  }
  return longest;
}

/** Compact user-facing durations, including sub-second cooldowns. */
export function formatDelayMs(ms: number): string {
  let remaining = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms)) : 0;
  if (remaining === 0) return "0 s";
  if (remaining < 1_000) return `${remaining} ms`;
  const parts: string[] = [];
  for (const [factor, suffix] of [[86_400_000, "d"], [3_600_000, "h"], [60_000, "min"]] as const) {
    const amount = Math.floor(remaining / factor);
    if (amount) parts.push(`${amount} ${suffix}`);
    remaining %= factor;
  }
  if (remaining) parts.push(`${remaining / 1_000} s`);
  return parts.join(" ");
}
