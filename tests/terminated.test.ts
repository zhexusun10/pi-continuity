import assert from "node:assert/strict";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CONTINUATION_TYPE } from "../lib/continuity.ts";
import { allText, createHarness } from "./harness.ts";

const terminated = (text = "partial plan") =>
  fauxAssistantMessage(text, { stopReason: "error", errorMessage: "terminated" });

for (const errorMessage of ["terminated", "TypeError: terminated"]) {
  test(`${errorMessage} fallback preserves safe partial context and raw failure history`, async (t) => {
    let executed = 0;
    const h = await createHarness({ tools: [{
      name: "finish", label: "Finish", description: "Test tool", parameters: Type.Object({}),
      async execute() {
        executed++;
        return { content: [{ type: "text", text: "tool finished" }], details: undefined };
      },
    }] });
    t.after(h.cleanup);
    const failure = fauxAssistantMessage([
      { type: "thinking", thinking: "unfinished reasoning", thinkingSignature: "OPAQUE_SIGNATURE" },
      { type: "thinking", thinking: "REDACTED_THINKING", redacted: true, thinkingSignature: "ENCRYPTED" },
      { type: "text", text: "partial answer", textSignature: "RESPONSE_ITEM_ID" },
      fauxToolCall("finish", { incomplete: "UNSAFE_ARGUMENT" }),
    ], { stopReason: "error", errorMessage });
    h.setResponses([failure, fauxAssistantMessage("done")]);
    await h.session.prompt("Finish the task");
    assert.equal(h.requests.length, 2);
    assert.equal(h.faux.state.callCount, 2);
    assert.equal(executed, 0);
    assert.equal(h.continuations().length, 1);
    assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 0);
    assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
    assert.equal(h.events.at(-1)?.type, "agent_settled");
    const next = h.requests[1]!;
    assert.match(allText(next), /unfinished reasoning.*partial answer/s);
    assert.match(allText(next), /NOT executed/);
    assert.doesNotMatch(JSON.stringify(next), /OPAQUE_SIGNATURE|REDACTED_THINKING|ENCRYPTED|RESPONSE_ITEM_ID|UNSAFE_ARGUMENT/);
    assert.equal(next.some((message) => message.role === "toolResult" ||
      (message.role === "assistant" && message.stopReason === "error")), false);
    const original = h.manager.getBranch().find((entry) => entry.type === "message" &&
      entry.message.role === "assistant" && entry.message.stopReason === "error");
    assert.ok(original?.type === "message" && original.message.role === "assistant");
    assert.equal(original.message.stopReason, "error");
    assert.equal(original.message.errorMessage, errorMessage);
    assert.deepEqual(original.message.content, failure.content);
    const emitted = h.events.find((event) => event.type === "message_end" &&
      event.message.role === "assistant" && event.message.stopReason === "error");
    assert.ok(emitted?.type === "message_end" && emitted.message.role === "assistant");
    assert.deepEqual(original.message.usage, emitted.message.usage);
    assert.ok(original.message.usage.output > 0);
    assert.ok(h.manager.getBranch().some((entry) => entry.type === "context_edit" &&
      entry.targetId === original.id && entry.replacement === null));
    assert.deepEqual(h.errors, []);
  });
}

for (const nativeRetries of [0, 1]) {
  test(`a thrown TypeError("terminated") recovers with ${nativeRetries ? "native retry" : "fallback"} and no checkpoint`, async (t) => {
    const h = await createHarness({ nativeRetries });
    t.after(h.cleanup);
    h.setResponses([() => { throw new TypeError("terminated"); }, fauxAssistantMessage("done")]);
    await h.session.prompt("Finish the task");
    assert.equal(h.requests.length, 2);
    assert.equal(h.faux.state.callCount, 2);
    assert.equal(h.continuations().length, nativeRetries ? 0 : 1);
    assert.equal(h.checkpoints().length, 0);
    assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, nativeRetries);
    const original = h.manager.getBranch().find((entry) => entry.type === "message" &&
      entry.message.role === "assistant" && entry.message.stopReason === "error");
    assert.ok(original?.type === "message" && original.message.role === "assistant");
    assert.equal(original.message.errorMessage, "terminated");
    assert.deepEqual(original.message.content, []);
    assert.equal(h.events.at(-1)?.type, "agent_settled");
    assert.deepEqual(h.errors, []);
  });
}

test("terminated fallback runs only after native retries are exhausted", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  h.setResponses([terminated("plan one"), terminated("plan two"), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 3);
  assert.equal(h.faux.state.callCount, 3);
  assert.equal(h.continuations().length, 1);
  assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 1);
  const nativeEnd = h.events.findIndex((event) => event.type === "auto_retry_end" &&
    !event.success && event.finalError === "terminated");
  const fallback = h.events.findIndex((event) => event.type === "entry_appended" &&
    event.entry.type === "custom" && event.entry.customType === CONTINUATION_TYPE);
  assert.ok(nativeEnd >= 0 && fallback > nativeEnd);
  assert.match(allText(h.requests[1]!), /plan one/);
  const recovered = allText(h.requests[2]!);
  assert.match(recovered, /plan one.*plan two/s);
  assert.equal((recovered.match(/The preceding provider response was interrupted/g) ?? []).length, 1);
  assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
  assert.deepEqual(h.errors, []);
});

test("persistent terminated errors exhaust the stream budget without rewriting failure", async (t) => {
  const h = await createHarness({ nativeRetries: 1, flags: { "continuity-stream-retries": "1" } });
  t.after(h.cleanup);
  h.setResponses([...Array.from({ length: 4 }, () => terminated()), fauxAssistantMessage("unused")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 4);
  assert.equal(h.faux.state.callCount, 4);
  assert.equal(h.continuations().length, 1);
  assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 2);
  const final = h.session.messages.findLast((message) => message.role === "assistant");
  assert.ok(final?.role === "assistant");
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "terminated");
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "assistant" && entry.message.stopReason === "error" &&
    entry.message.errorMessage === "terminated").length, 4);
  assert.equal(h.events.at(-1)?.type, "agent_settled");
  assert.deepEqual(h.errors, []);
});

test("an aborted response with terminated error text never retries", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  h.setResponses([
    fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "terminated" }),
    fauxAssistantMessage("unused"),
  ]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.faux.state.callCount, 1);
  assert.equal(h.continuations().length, 0);
  assert.equal(h.checkpoints().length, 0);
  assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 0);
  assert.deepEqual(h.errors, []);
});

test("cancellation during terminated fallback prevents another model request", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-delay-ms": "100" } });
  t.after(h.cleanup);
  let cancel: Promise<void> | undefined;
  h.setResponses([() => {
    setTimeout(() => { cancel = h.session.abort(); }, 10);
    return terminated();
  }, fauxAssistantMessage("unused")]);
  await h.session.prompt("Finish the task");
  await cancel;
  assert.equal(h.requests.length, 1);
  assert.equal(h.faux.state.callCount, 1);
  assert.equal(h.events.at(-1)?.type, "agent_settled");
  assert.deepEqual(h.errors, []);
});

test("queued steering input after terminated needs no extension fallback", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  h.setResponses([async () => {
    await h.session.prompt("New user instruction", { streamingBehavior: "steer" });
    return terminated();
  }, fauxAssistantMessage("done")]);
  await h.session.prompt("Original instruction");
  assert.equal(h.requests.length, 2);
  assert.equal(h.faux.state.callCount, 2);
  assert.equal(h.continuations().length, 0);
  assert.match(allText(h.requests[1]!), /New user instruction/);
  assert.match(allText(h.requests[1]!), /partial plan/);
  assert.equal(h.events.at(-1)?.type, "agent_settled");
  assert.deepEqual(h.errors, []);
});
