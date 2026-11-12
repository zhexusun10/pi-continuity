import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { fakeClock, until } from "./clock.ts";
import { allText, createHarness } from "./harness.ts";

const failed = (errorMessage = "fetch failed") => fauxAssistantMessage("partial plan", { stopReason: "error", errorMessage });

for (const [name, response] of [
  ["native-classified stream", failed()], ["extension-classified stream", failed("Unexpected EOF")],
  ["empty response", fauxAssistantMessage([])], ["reasoning-only response", fauxAssistantMessage(fauxThinking("partial reasoning"))],
] as const) {
  test(`SDK abort immediately interrupts ${name} backoff without advancing the clock`, async (t) => {
    const h = await createHarness({ flags: { "continuity-stream-delay-ms": "10000" } });
    const clock = fakeClock(t);
    t.after(async () => { clock.advance(100_000); await h.session.abort(); h.cleanup(); });
    h.setResponses([response, fauxAssistantMessage("unused")]);
    let settled = false;
    const run = h.session.prompt("Task").then(() => { settled = true; });
    await until(() => clock.pending() > 0);
    const abort = h.session.abort();
    await until(() => settled);
    await run;
    await abort;
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(h.errors, []);
  });
}

test("exhausted native retry also has a cancellable fallback wait before settlement", async (t) => {
  const h = await createHarness({ nativeRetries: 1, flags: { "continuity-stream-delay-ms": "10000" } });
  const clock = fakeClock(t);
  t.after(async () => { clock.advance(100_000); await h.session.abort(); h.cleanup(); });
  h.setResponses([failed(), failed(), fauxAssistantMessage("unused")]);
  let settled = false;
  const run = h.session.prompt("Task").then(() => { settled = true; });
  await until(() => clock.pending() > 0);
  clock.advance(10_000);
  await until(() => h.events.some((event) => event.type === "auto_retry_start"));
  clock.advance(0);
  await until(() => h.requests.length === 2 && clock.pending() > 0);
  const abort = h.session.abort();
  await until(() => settled);
  await run;
  await abort;
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(h.errors, []);
});

for (const kind of ["stream", "empty"] as const) {
  for (const queued of ["steer", "followUp"] as const) {
    test(`${queued} input replaces ${kind} backoff within one pending-work poll`, async (t) => {
      const h = await createHarness({ flags: { "continuity-stream-delay-ms": "10000" } });
      t.after(h.cleanup);
      const clock = fakeClock(t);
      h.setResponses([kind === "stream" ? failed("Unexpected EOF") : fauxAssistantMessage([]), fauxAssistantMessage("done")]);
      const run = h.session.prompt("Old instruction");
      await until(() => clock.pending() > 0);
      if (queued === "steer") await h.session.steer("New instruction");
      else await h.session.followUp("New instruction");
      clock.advance(1_000);
      await run;
      assert.equal(h.requests.length, 2);
      assert.equal(h.continuations().length, 0);
      assert.match(allText(h.requests[1]!), /New instruction/);
      assert.equal(clock.pending(), 0);
      assert.deepEqual(h.errors, []);
    });
  }
}

for (const edit of ["redact", "omit"] as const) {
  test(`queued-error progress respects earlier request-context ${edit}`, async (t) => {
    const h = await createHarness({ before: (pi) => {
      pi.on("context", (event) => ({ messages: event.messages.flatMap((message) => {
        if (message.role !== "assistant" || message.stopReason !== "error") return [message];
        return edit === "omit" ? [] : [{ ...message, content: [{ type: "text" as const, text: "[redacted]" }] }];
      }) }));
    } });
    t.after(h.cleanup);
    h.setResponses([async () => {
      await h.session.followUp("New instruction");
      return fauxAssistantMessage("PRIVATE_SECRET", { stopReason: "error", errorMessage: "Unexpected EOF" });
    }, fauxAssistantMessage("done")]);
    await h.session.prompt("Old instruction");
    assert.equal(h.requests.length, 2);
    assert.match(allText(h.requests[1]!), /New instruction/);
    assert.doesNotMatch(allText(h.requests[1]!), /PRIVATE_SECRET/);
    assert.doesNotMatch(allText(h.requests[1]!), /\[redacted\]/);
    assert.equal(h.checkpoints().length, 0);
    assert.equal(h.continuations().length, 0);
    assert.deepEqual(h.errors, []);
  });
}

test("same-millisecond failures cannot resurrect an older request after context redaction", async (t) => {
  const h = await createHarness({ before: (pi) => {
    pi.on("context", (event) => ({ messages: event.messages.filter((message) =>
      message.role !== "assistant" || !allText([message]).includes("PRIVATE_NEW")) }));
  } });
  t.after(h.cleanup);
  fakeClock(t);
  await h.session.prompt("/pi-continuity off");
  h.setResponses([fauxAssistantMessage("PRIVATE_OLD", { stopReason: "error", errorMessage: "Unexpected EOF" })]);
  await h.session.prompt("Old task");
  await h.session.prompt("/pi-continuity on");
  h.setResponses([async () => {
    await h.session.followUp("Queued instruction");
    return fauxAssistantMessage("PRIVATE_NEW", { stopReason: "error", errorMessage: "Unexpected EOF" });
  }, fauxAssistantMessage("done")]);
  await h.session.prompt("New task");
  assert.equal(h.requests.length, 3);
  assert.match(allText(h.requests[2]!), /Queued instruction/);
  assert.doesNotMatch(allText(h.requests[2]!), /PRIVATE_OLD|PRIVATE_NEW/);
  assert.deepEqual(h.errors, []);
});

test("queued-error context never injects partial reasoning, tool arguments, or signatures", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  h.setResponses([async () => {
    await h.session.followUp("New instruction");
    return fauxAssistantMessage([
      { type: "thinking", thinking: "safe reasoning", thinkingSignature: "OPAQUE_SIGNATURE" },
      { type: "thinking", thinking: "HIDDEN_THINKING", redacted: true },
      fauxToolCall("step", { partial: "UNSAFE_ARGUMENTS" }),
    ], { stopReason: "error", errorMessage: "Unexpected EOF" });
  }, fauxAssistantMessage("done")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.doesNotMatch(allText(h.requests[1]!), /safe reasoning|NOT executed/);
  assert.equal(h.checkpoints().length, 0);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /OPAQUE_SIGNATURE|HIDDEN_THINKING|UNSAFE_ARGUMENTS/);
  assert.equal(h.continuations().length, 0);
  assert.deepEqual(h.errors, []);
});

for (const response of [failed("cooldown: 1h 2miutes"), failed("fetch failed"), fauxAssistantMessage([])]) {
  test(`off cancels the live wait without another extension request: ${response.errorMessage ?? "empty"}`, async (t) => {
    const h = await createHarness({ flags: { "continuity-stream-delay-ms": "10000" } });
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([response, fauxAssistantMessage("unused")]);
    const run = h.session.prompt("Task");
    await until(() => clock.pending() > 0);
    await h.session.prompt("/pi-continuity off");
    await run;
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.equal(h.checkpoints().length, 0);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(h.errors, []);
  });
}
