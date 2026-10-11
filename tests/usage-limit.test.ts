import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import { setImmediate } from "node:timers/promises";
import { Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  APPROXIMATE_RESET_BUFFER_MS, DEFAULT_OPTIONS, RecoveryBudget, USAGE_POLL_DELAY_MS, USAGE_POLL_MAX_ATTEMPTS,
  USAGE_POLL_WINDOW_MS, recoveryReason, usageLimitDelayMs, waitForBackoff,
} from "../lib/continuity.ts";
import { allText, createHarness } from "./harness.ts";

const usageError = (minutes = 300, content = "partial plan", approximate = true) => fauxAssistantMessage(content, {
  stopReason: "error",
  errorMessage: `You have hit your ChatGPT usage limit (plus plan). Try again in ${approximate ? "~" : ""}${minutes} min.`,
});

const pollError = (content = "partial plan") => fauxAssistantMessage(content, {
  stopReason: "error", errorMessage: "Codex error: The usage limit has been reached",
});

/** Virtual wall clock without experimental MockTimers or real minute/hour waits. */
function fakeClock(t: TestContext) {
  let now = 1_800_000_000_000;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  const delays: number[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timer = nodeSetTimeout(() => {}, 0);
    nodeClearTimeout(timer);
    timers.set(timer, { at: now + delay, run: () => callback(...args) });
    delays.push(delay);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout> | string | number | undefined) => {
    if (typeof timer === "object") timers.delete(timer);
    nodeClearTimeout(timer);
  });
  return {
    delays,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.at <= now);
        if (!due) return;
        timers.delete(due[0]);
        due[1].run();
      }
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.ok(predicate(), "expected asynchronous boundary state was not reached");
}

for (const [error, minutes] of [
  ["You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.", 120],
  ["Error: You have hit your ChatGPT usage limit (pro plan). Try again in ~300 min.", 300],
  ["You have hit your ChatGPT usage limit. Try again in ~401 min.", 401],
  ["Codex error: Try again in ~402 min.", 402],
  ["429 usage_limit_reached. Try again in ~403 min.", 403],
  ["subscription_sharing_usage_limit_exceeded: Try again in 10 minutes.", 10],
  ["Provider limit. RETRY IN 2 mins.", 2],
  ["Try again in ~0 min.", 0],
  ["Try again in 0.5 min.", 0.5],
] as const) {
  test(`captures provider-independent minute guidance: ${error}`, () => {
    assert.equal(usageLimitDelayMs(error), minutes * 60_000 + (error.includes("~") ? APPROXIMATE_RESET_BUFFER_MS : 0));
    assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: error })), "usage-limit");
  });
}

for (const errorMessage of [
  "You have hit your ChatGPT usage limit.", "Try again in ~N min.", "Try again in -5 min.",
  "Try again in Infinity min.", "Try again in NaN min.", "Try again in 1e3 min.",
  "Try again in 9007199254740992 min.", "Try again in 2 seconds.", "Try again in 2 hours.",
]) {
  test(`missing/invalid guidance falls back to bounded polling: ${errorMessage}`, () => {
    assert.equal(usageLimitDelayMs(errorMessage), undefined);
    assert.equal(recoveryReason(fauxAssistantMessage("", {
      stopReason: "error", errorMessage: `usage limit reached: ${errorMessage}`,
    })), "usage-limit");
  });
}

test("usage-limit polling has a fixed 15-minute schedule within a five-hour window", () => {
  assert.equal(USAGE_POLL_DELAY_MS, 15 * 60_000);
  assert.equal(USAGE_POLL_WINDOW_MS, 5 * 60 * 60_000);
  assert.equal(USAGE_POLL_MAX_ATTEMPTS, 20);
  for (const error of [
    "Codex error: The usage limit has been reached",
    "You have hit your ChatGPT usage limit (plus plan).",
    "monthly usage limit reached",
    "subscription_sharing_usage_limit_exceeded",
    "usage_limit_reached",
  ]) {
    assert.equal(usageLimitDelayMs(error), undefined);
    assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: error })), "usage-limit");
  }
});

test("billing/quota exhaustion keeps guidance-less limits terminal", () => {
  for (const errorMessage of [
    "insufficient_quota", "quota exceeded", "out of budget", "billing exhausted", "available balance",
    "usage limit reached; insufficient_quota",
  ]) {
    assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage })), undefined);
  }
});

test("guidance in successful output or an aborted response never authorizes recovery", () => {
  assert.equal(recoveryReason(fauxAssistantMessage("Try again in ~5 min.")), undefined);
  assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Try again in ~5 min." })), undefined);
  for (const errorMessage of ["401 authentication failed", "invalid API key", "content_filter", "context_length_exceeded"]) {
    assert.equal(recoveryReason(fauxAssistantMessage("", {
      stopReason: "error", errorMessage: `${errorMessage}. Try again in ~5 min.`,
    })), undefined);
  }
});

test("timed usage recovery shares the total cap, not the short stream retry budget", () => {
  const budget = new RecoveryBudget();
  const options = { ...DEFAULT_OPTIONS, maxResumes: 1, streamRetries: 0 };
  assert.equal(budget.canResume("usage-limit", options), true);
  budget.record("usage-limit");
  assert.equal(budget.counts["usage-limit"], 1);
  assert.equal(budget.streams, 0);
  assert.equal(budget.canResume("usage-limit", options), false);
});

test("long backoffs are segmented without overflowing Node's timer limit", async (t) => {
  const clock = fakeClock(t);
  const delay = 2_147_483_647 + 60_000;
  let completed = false;
  const pending = waitForBackoff(delay).then((result) => { completed = result; });
  assert.equal(clock.delays[0], 2_147_483_647);
  clock.advance(2_147_483_647);
  await setImmediate();
  assert.equal(completed, false);
  assert.equal(clock.delays[1], 60_000);
  clock.advance(59_999);
  await setImmediate();
  assert.equal(completed, false);
  clock.advance(1);
  await pending;
  assert.equal(completed, true);
  assert.equal(clock.pending(), 0);
});

test("cancellation removes the long-wait timer and abort listener", async (t) => {
  const clock = fakeClock(t);
  const controller = new AbortController();
  const pending = waitForBackoff(300 * 60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(clock.pending(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const errorMessage of [
  "You have hit your ChatGPT usage limit (plus plan). Try again in ~300 min.",
  "You have hit your ChatGPT usage limit (pro plan). Try again in ~300 min.",
  "You have hit your ChatGPT usage limit. Try again in ~300 min.",
  "Codex error: You have hit your ChatGPT usage limit. Try again in ~300 min.",
  "subscription_sharing_usage_limit_exceeded: Usage limit reached. Try again in ~300 min.",
  "Other login/API: quota exceeded. Try again in ~300 min.",
]) {
  test(`waits five hours before continuation regardless of provider/login: ${errorMessage}`, async (t) => {
    const h = await createHarness({ nativeRetries: 1, flags: { "continuity-stream-retries": "0" } });
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([fauxAssistantMessage("keep this plan", { stopReason: "error", errorMessage }), fauxAssistantMessage("done")]);
    let settled = false;
    const run = h.session.prompt("Finish the task").then(() => { settled = true; });
    await until(() => clock.pending() > 0);
    clock.advance(300 * 60_000 - 1);
    await setImmediate();
    assert.equal(h.requests.length, 1);
    assert.equal(settled, false);
    assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 0);
    clock.advance(1);
    await setImmediate();
    assert.equal(h.requests.length, 1, "rounded ~ minutes get a 30-second reset margin");
    clock.advance(APPROXIMATE_RESET_BUFFER_MS);
    await run;
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 1);
    assert.match(allText(h.requests[1]!), /keep this plan/);
    assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
    assert.deepEqual(h.errors, []);
  });
}

test("guidance-less usage limits poll every 15 minutes until the provider recovers", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([pollError("FIRST_PARTIAL"), pollError("SECOND_PARTIAL"), fauxAssistantMessage("done")]);
  const run = h.session.prompt("Finish the task");
  await until(() => clock.pending() > 0);
  clock.advance(USAGE_POLL_DELAY_MS - 1);
  await setImmediate();
  assert.equal(h.requests.length, 1);
  clock.advance(1);
  await until(() => h.requests.length === 2 && clock.pending() > 0);
  assert.match(allText(h.requests[1]!), /FIRST_PARTIAL/);
  clock.advance(USAGE_POLL_DELAY_MS);
  await run;
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 2);
  assert.match(allText(h.requests[2]!), /SECOND_PARTIAL/);
  const raw = h.manager.getBranch().find((entry) => entry.type === "message" &&
    entry.message.role === "assistant" && entry.message.stopReason === "error");
  assert.ok(raw?.type === "message" && raw.message.role === "assistant");
  assert.equal(raw.message.errorMessage, "Codex error: The usage limit has been reached");
  assert.deepEqual(h.errors, []);
});

test("guidance-less polling gives up after five hours without rewriting the failure", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([...Array.from({ length: USAGE_POLL_MAX_ATTEMPTS + 1 }, () => pollError()), fauxAssistantMessage("unused")]);
  const run = h.session.prompt("Finish the task");
  for (let attempt = 0; attempt < USAGE_POLL_MAX_ATTEMPTS; attempt++) {
    await until(() => clock.pending() > 0);
    clock.advance(USAGE_POLL_DELAY_MS);
  }
  await run;
  assert.equal(h.requests.length, USAGE_POLL_MAX_ATTEMPTS + 1);
  assert.equal(h.continuations().length, USAGE_POLL_MAX_ATTEMPTS);
  assert.equal(h.events.at(-1)?.type, "agent_settled");
  const failures = h.manager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "assistant" && entry.message.stopReason === "error");
  assert.equal(failures.length, USAGE_POLL_MAX_ATTEMPTS + 1);
  assert.deepEqual(h.errors, []);
});

test("usage-limit polling is bounded by its own window, not the resume cap", async (t) => {
  const h = await createHarness({ flags: { "continuity-max-resumes": "1" } });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([pollError(), pollError(), fauxAssistantMessage("done")]);
  const run = h.session.prompt("Finish the task");
  await until(() => clock.pending() > 0);
  clock.advance(USAGE_POLL_DELAY_MS);
  await until(() => h.requests.length === 2 && clock.pending() > 0);
  clock.advance(USAGE_POLL_DELAY_MS);
  await run;
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 2);
  assert.deepEqual(h.errors, []);
});

for (const cancel of ["abort", "direct-queue"] as const) {
  test(`${cancel} interrupts a usage-limit poll without an extension continuation`, async (t) => {
    const h = await createHarness();
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([pollError(), fauxAssistantMessage("new instruction done")]);
    const run = h.session.prompt("Original task");
    await until(() => clock.pending() > 0);
    if (cancel === "abort") {
      const aborted = h.session.abort();
      await run;
      await aborted;
    } else {
      await h.session.steer("New instruction");
      clock.advance(1_000);
      await run;
    }
    assert.equal(h.continuations().length, 0);
    assert.equal(h.requests.length, cancel === "direct-queue" ? 2 : 1);
    if (h.requests.length === 2) assert.match(allText(h.requests[1]!), /New instruction/);
    assert.equal(h.events.at(-1)?.type, "agent_settled");
    assert.deepEqual(h.errors, []);
  });
}

for (const flags of [{ continuity: "false" }, { "continuity-max-resumes": "0" }] as Record<string, string>[]) {
  test(`disabled recovery does not poll guidance-less usage limits: ${JSON.stringify(flags)}`, async (t) => {
    const h = await createHarness({ flags });
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([pollError(), fauxAssistantMessage("unused")]);
    await h.session.prompt("Task");
    assert.equal(clock.pending(), 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.deepEqual(h.errors, []);
  });
}

for (const errorMessage of ["insufficient_quota", "billing exhausted"]) {
  test(`terminal account limit without guidance never polls: ${errorMessage}`, async (t) => {
    const h = await createHarness();
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage }), fauxAssistantMessage("unused")]);
    await h.session.prompt("Task");
    assert.equal(clock.pending(), 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.deepEqual(h.errors, []);
  });
}

for (const [minutes, approximate, delayMs] of [[5, false, 5 * 60_000], [0, true, APPROXIMATE_RESET_BUFFER_MS]] as const) {
  test(`exact ${minutes} min / approximate=${approximate} waits the full reset delay`, async (t) => {
    const h = await createHarness();
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([usageError(minutes, "partial plan", approximate), fauxAssistantMessage("done")]);
    const run = h.session.prompt("Task");
    await until(() => clock.pending() > 0);
    clock.advance(delayMs - 1);
    await setImmediate();
    assert.equal(h.requests.length, 1);
    clock.advance(1);
    await run;
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 1);
    assert.deepEqual(h.errors, []);
  });
}

test("timed recovery preserves earlier boundary redactions and entries", async (t) => {
  const h = await createHarness({ before: (pi) => {
    pi.on("turn_end", (event) => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
      return { entries: [...event.entries,
        { type: "custom", customType: "other-extension", data: true },
        { type: "context_edit", targetId: event.messageEntryId, replacement: { content: "[redacted]" } },
      ] };
    });
  } });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([usageError(5, "PRIVATE_SECRET"), fauxAssistantMessage("done")]);
  const run = h.session.prompt("Task");
  await until(() => clock.pending() > 0);
  clock.advance(5 * 60_000 + APPROXIMATE_RESET_BUFFER_MS);
  await run;
  assert.equal(h.requests.length, 2);
  assert.doesNotMatch(allText(h.requests[1]!), /PRIVATE_SECRET/);
  assert.match(allText(h.requests[1]!), /\[redacted\]/);
  assert.ok(h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "other-extension"));
  assert.deepEqual(h.errors, []);
});

test("native 429 retry cannot run before the advertised reset", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([fauxAssistantMessage("partial plan", {
    stopReason: "error", errorMessage: "429 rate limit exceeded. Try again in ~5 min.",
  }), fauxAssistantMessage("done")]);
  const run = h.session.prompt("Task");
  await until(() => clock.pending() > 0);
  clock.advance(5 * 60_000 - 1);
  await setImmediate();
  assert.equal(h.requests.length, 1);
  assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 0);
  clock.advance(1 + APPROXIMATE_RESET_BUFFER_MS);
  await until(() => h.events.some((event) => event.type === "auto_retry_start"));
  clock.advance(0);
  await run;
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.deepEqual(h.errors, []);
});

test("timed recovery preserves raw failure/usage and excludes partial tool arguments", async (t) => {
  let executed = 0;
  const h = await createHarness({ tools: [{
    name: "finish", label: "Finish", description: "Test tool", parameters: Type.Object({}),
    async execute() {
      executed++;
      return { content: [{ type: "text", text: "done" }], details: undefined };
    },
  }] });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  const failure = fauxAssistantMessage([
    { type: "thinking", thinking: "unfinished reasoning", thinkingSignature: "OPAQUE_SIGNATURE" },
    fauxToolCall("finish", { content: "UNSAFE_ARGUMENTS" }),
  ], { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit. Try again in ~5 min." });
  h.setResponses([failure, fauxAssistantMessage("done")]);
  const run = h.session.prompt("Task");
  await until(() => clock.pending() > 0);
  clock.advance(5 * 60_000 + APPROXIMATE_RESET_BUFFER_MS);
  await run;
  assert.equal(executed, 0);
  assert.match(allText(h.requests[1]!), /unfinished reasoning/);
  assert.match(allText(h.requests[1]!), /NOT executed/);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /OPAQUE_SIGNATURE|UNSAFE_ARGUMENTS/);
  const original = h.manager.getBranch().find((entry) => entry.type === "message" &&
    entry.message.role === "assistant" && entry.message.stopReason === "error");
  assert.ok(original?.type === "message" && original.message.role === "assistant");
  assert.equal(original.message.errorMessage, failure.errorMessage);
  assert.deepEqual(original.message.content, failure.content);
  assert.ok(original.message.usage.output > 0);
  assert.deepEqual(h.errors, []);
});

for (const cancel of ["abort", "off", "input", "direct-queue"] as const) {
  test(`${cancel} interrupts a five-hour wait without an extension continuation`, async (t) => {
    const h = await createHarness();
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([usageError(), fauxAssistantMessage("new instruction done")]);
    const run = h.session.prompt("Original task");
    await until(() => clock.pending() > 0);
    if (cancel === "abort") {
      const aborted = h.session.abort();
      await run;
      await aborted;
    } else if (cancel === "off") {
      await h.session.prompt("/pi-continuity off");
      await run;
    } else if (cancel === "input") {
      await h.session.prompt("New instruction", { streamingBehavior: "steer" });
      await run;
    } else {
      await h.session.steer("New instruction");
      clock.advance(1_000);
      await run;
    }
    assert.equal(h.continuations().length, 0);
    assert.equal(h.requests.length, cancel === "input" || cancel === "direct-queue" ? 2 : 1);
    if (h.requests.length === 2) assert.match(allText(h.requests[1]!), /New instruction/);
    assert.equal(h.events.at(-1)?.type, "agent_settled");
    assert.deepEqual(h.errors, []);
  });
}

test("repeated zero-minute limits are bounded and the next real user request gets a fresh budget", async (t) => {
  const h = await createHarness({ flags: { "continuity-max-resumes": "2" } });
  t.after(h.cleanup);
  h.setResponses([usageError(0, "partial plan", false), usageError(0, "partial plan", false), usageError(0, "partial plan", false), fauxAssistantMessage("unused")]);
  await h.session.prompt("First task");
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 2);
  h.setResponses([usageError(0, "partial plan", false), fauxAssistantMessage("done")]);
  await h.session.prompt("Second task");
  assert.equal(h.requests.length, 5);
  assert.equal(h.continuations().length, 3);
  assert.deepEqual(h.errors, []);
});

const disabledFlags: Record<string, string>[] = [{ continuity: "false" }, { "continuity-max-resumes": "0" }];
for (const flags of disabledFlags) {
  test(`disabled recovery does not wait on the provider limit: ${JSON.stringify(flags)}`, async (t) => {
    const h = await createHarness({ flags });
    t.after(h.cleanup);
    h.setResponses([usageError(), fauxAssistantMessage("unused")]);
    await h.session.prompt("Task");
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.deepEqual(h.errors, []);
  });
}
