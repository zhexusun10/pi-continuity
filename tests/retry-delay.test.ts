import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { APPROXIMATE_RESET_BUFFER_MS, formatDelayMs, recoveryReason, usageLimitDelayMs } from "../lib/continuity.ts";
import { fakeClock, until } from "./clock.ts";
import { allText, createHarness } from "./harness.ts";

const failed = (errorMessage: string) => fauxAssistantMessage("safe partial plan", { stopReason: "error", errorMessage });

const cases: readonly (readonly [string, number])[] = [
  ["cooldown: 12s", 12_000], ["Cooldown： 0.25s", 250], ["cool-down = 10 sec", 10_000],
  ["cooldown is 12s", 12_000], ["cooldown for 1min", 60_000], ["cooldown in 2miutes", 120_000],
  ["cool_down: 500ms", 500], ["cooldown: 1 h", 3_600_000], ["cooldown: 2 min", 120_000],
  ["cooldown: 2 minutes", 120_000], ["cooldown: 2 miutes", 120_000],
  ["cooldown: 2 minuites", 120_000], ["cooldown: 2 mintues", 120_000],
  ["cooldown: 2 mins", 120_000], ["cooldown: 2 m", 120_000],
  ["cooldown: 1hour", 3_600_000], ["cooldown: 2 hrs", 7_200_000],
  ["cooldown: 1h2min3s", 3_723_000], ["cooldown: 1 h 2 min 3.5 s", 3_723_500],
  ["cooldown: 1 hour, 2 minutes and 3 seconds", 3_723_000],
  ["cooldown: 1 day 2h", 93_600_000], ["cooldown: 5 milliseconds", 5],
  ["cooldown: 1.25m", 75_000], ["cooldown: .5s", 500], ["cooldown: 0s", 0],
  ["cooldown: ~2 min", 120_000 + APPROXIMATE_RESET_BUFFER_MS],
  ["cooldown: ~2 s", 2_500], ["cooldown: approximately 1 h", 5_400_000],
  ["Retry in 2 seconds.", 2_000], ["Try again in 2 hours.", 7_200_000],
  ["Please retry after 1.5 secs.", 1_500], ["Retrying in 50 msecs", 50],
  ["Please wait 3s before retrying.", 3_000], ["reset in 1h 30min", 5_400_000],
  ["Retry-After: 120", 120_000], ["Retry-After: 0.5", 500],
  ['{"retry_after":12}', 12_000], ['{"retryAfter":1.5}', 1_500],
  ['{"retry_after_ms":1500}', 1_500], ['{"retryAfterMs":"1500"}', 1_500],
  ['{"cooldown_seconds":12}', 12_000], ['{"cooldown_ms":200}', 200],
  ['{"retry_after_minutes":2}', 120_000], ['{"cooldown_h":1.5}', 5_400_000],
  ['{"retryAfterMiutes":2}', 120_000], ["Retry-After: 60\nX-Request-ID: 401", 60_000],
  ['{"retryDelay":"3.5s"}', 3_500], ['{"cooldown":"1h 2miutes"}', 3_720_000],
  ["Retry-After: 60; cooldown: 90s", 90_000],
  ["cooldown: 90s; retry in 1 min", 90_000],
  ["usage limit reached. cooldown: 401s", 401_000],
];

for (const [error, expected] of cases) {
  test(`captures explicit retry duration: ${error}`, () => {
    assert.equal(usageLimitDelayMs(error), expected);
    assert.equal(recoveryReason(failed(error)), "usage-limit");
  });
}

for (const error of [
  "cooldown: -5s", "cooldown: +5s", "cooldown: NaNs", "cooldown: Infinity s",
  "cooldown: 1e3s", "cooldown: 1.2.3s", "cooldown: 1m -5s", "cooldown: 1m 2e3s",
  "cooldown: 10 secondsx", "cooldown: 1 month", "cooldown: 100", "retry in 100", "retry after 100",
  "Retry-After: -5", 'Retry-After: "Infinity"', "Retry-After: 1e3", "cooldown: 9007199254740992h",
  "Retry-After: 1 month", "Retry-After: 5 secondsx", "cooldown: 1m NaNs", "cooldown: 1s/2s",
  "cooldown: 5s_to_reset", "request took 30s; request_id=503", "timeout: 10s", "retry count: 5",
  "cooldown_enabled: 1", "last_retry_after_id: 500", "request body: {\"duration\":\"5s\"}",
]) {
  test(`rejects invalid or unrelated retry duration: ${error}`, () => {
    assert.equal(usageLimitDelayMs(error), undefined);
  });
}

for (const [ms, expected] of [[0, "0 s"], [250, "250 ms"], [1_500, "1.5 s"], [60_000, "1 min"],
  [3_723_000, "1 h 2 min 3 s"], [86_400_000, "1 d"]] as const) {
  test(`duration display uses appropriate units: ${ms}`, () => assert.equal(formatDelayMs(ms), expected));
}

test("duration aliases agree over a range of fractional values", () => {
  for (const [unit, factor] of [["ms", 1], ["s", 1_000], ["min", 60_000], ["miutes", 60_000], ["h", 3_600_000]] as const) {
    for (let n = 0; n <= 32; n++) {
      assert.equal(usageLimitDelayMs(`cooldown: ${n / 4}${unit}`), Math.ceil(n / 4 * factor));
    }
  }
});

test("Retry-After HTTP-date is interpreted against the current clock, not as a duration", (t) => {
  fakeClock(t);
  const target = new Date(Date.now() + 90_000).toUTCString();
  assert.equal(usageLimitDelayMs(`Retry-After: ${target}`), 90_000);
  assert.equal(usageLimitDelayMs(`Retry-After: ${new Date(Date.now() - 1_000).toUTCString()}`), 0);
  assert.equal(usageLimitDelayMs("Retry-After: 2026-01-01"), undefined, "ambiguous dates are not parsed");
});

for (const error of ["401", "invalid API key", "content_filter", "context_length_exceeded", "Request was aborted"]) {
  test(`retry guidance never overrides terminal cause: ${error}`, () => {
    assert.equal(recoveryReason(failed(`${error}; cooldown: 5s`)), undefined);
  });
}

for (const [error, delay] of [
  ["cooldown: 1.5s", 1_500], ["Try again in 1h 2miutes", 3_720_000],
  ['{"retry_after_ms":250}', 250], ["Retry-After: 2", 2_000],
] as const) {
  test(`waits the advertised duration before recovery: ${error}`, async (t) => {
    const h = await createHarness({ flags: { "continuity-stream-retries": "0" } });
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([failed(error), fauxAssistantMessage("done")]);
    const run = h.session.prompt("Task");
    await until(() => clock.pending() > 0);
    clock.advance(delay - 1);
    await setImmediate();
    assert.equal(h.requests.length, 1);
    clock.advance(1);
    await run;
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 1);
    assert.doesNotMatch(allText(h.requests[1]!), /safe partial plan/);
    assert.equal(h.checkpoints().length, 0);
    assert.deepEqual(h.errors, []);
  });
}

test("a cooldown prevents native 429 retry from running early", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([failed("429 Too Many Requests; cooldown: 12s"), fauxAssistantMessage("done")]);
  const run = h.session.prompt("Task");
  await until(() => clock.pending() > 0);
  clock.advance(11_999);
  await setImmediate();
  assert.equal(h.requests.length, 1);
  assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 0);
  clock.advance(1);
  await until(() => h.events.some((event) => event.type === "auto_retry_start"));
  clock.advance(0);
  await run;
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.deepEqual(h.errors, []);
});

for (const error of ["cooldown: 0s", "Retry-After: 0", '{"retry_after_ms":0}']) {
  test(`zero-duration guidance remains bounded: ${error}`, async (t) => {
    const h = await createHarness({ flags: { "continuity-max-resumes": "2" } });
    t.after(h.cleanup);
    h.setResponses([failed(error), failed(error), failed(error), fauxAssistantMessage("unused")]);
    await h.session.prompt("Task");
    assert.equal(h.requests.length, 3);
    assert.equal(h.continuations().length, 2);
    assert.deepEqual(h.errors, []);
  });
}
