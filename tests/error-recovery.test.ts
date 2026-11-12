import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fakeClock, until } from "./clock.ts";
import { allText, createHarness } from "./harness.ts";

const failure = (errorMessage = 'Error: {"detail":"Bad Request"}', text = "partial plan") =>
  fauxAssistantMessage(text, { stopReason: "error", errorMessage });

for (const errorMessage of [
  'Error: {"detail":"Bad Request"}', '{"detail":"Bad Request"}',
  '400 {"detail":"Bad Request"}', "Bad Request", "unknown error", "An unexpected provider failure",
]) {
  test(`bounded fallback for an undiagnosed provider error: ${errorMessage}`, async (t) => {
    const h = await createHarness({ nativeRetries: 1 });
    t.after(h.cleanup);
    h.setResponses([failure(errorMessage), fauxAssistantMessage("done")]);
    await h.session.prompt("Finish the task");
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 1);
    assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 0);
    assert.doesNotMatch(allText(h.requests[1]!), /partial plan/);
    assert.equal(h.checkpoints().length, 0);
    const continuation = h.continuations()[0];
    assert.ok(continuation?.type === "custom");
    assert.ok(continuation.data && typeof continuation.data === "object" && "reason" in continuation.data);
    assert.equal(continuation.data.reason, "unknown-error");
    assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
    assert.deepEqual(h.errors, []);
  });
}

test("a thrown Bad Request is recoverable even without finalized partial content", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  h.setResponses([() => { throw new Error('{"detail":"Bad Request"}'); }, fauxAssistantMessage("done")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 1);
  assert.equal(h.checkpoints().length, 0);
  assert.deepEqual(h.errors, []);
});

for (const errorMessage of [undefined, "", "   "]) {
  test(`missing error diagnostics use the small fallback budget: ${JSON.stringify(errorMessage)}`, async (t) => {
    const h = await createHarness();
    t.after(h.cleanup);
    h.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage }), fauxAssistantMessage("done")]);
    await h.session.prompt("Task");
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 1);
    assert.deepEqual(h.errors, []);
  });
}

for (const maxResumes of ["16", "unlimited"]) {
  test(`persistent unknown errors stop after two fallbacks with total cap ${maxResumes}`, async (t) => {
    const h = await createHarness({ nativeRetries: 1, flags: { "continuity-max-resumes": maxResumes } });
    t.after(h.cleanup);
    h.setResponses([failure(), failure(), failure(), fauxAssistantMessage("unused")]);
    await h.session.prompt("Task");
    assert.equal(h.requests.length, 3);
    assert.equal(h.continuations().length, 2);
    const rawFailures = h.manager.getBranch().filter((entry) => entry.type === "message" &&
      entry.message.role === "assistant" && entry.message.stopReason === "error");
    assert.equal(rawFailures.length, 3);
    const final = rawFailures.at(-1);
    assert.ok(final?.type === "message" && final.message.role === "assistant");
    assert.equal(final.message.stopReason, "error");
    assert.equal(final.message.errorMessage, 'Error: {"detail":"Bad Request"}');
    assert.deepEqual(h.errors, []);
  });
}

for (const flags of [
  { continuity: "false" }, { "continuity-unknown-retries": "0" },
  { "continuity-stream-retries": "0" }, { "continuity-max-resumes": "0" },
] as Record<string, string>[]) {
  test(`unknown recovery can be disabled: ${JSON.stringify(flags)}`, async (t) => {
    const h = await createHarness({ flags });
    t.after(h.cleanup);
    h.setResponses([failure(), fauxAssistantMessage("unused")]);
    await h.session.prompt("Task");
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.equal(h.checkpoints().length, 0);
    assert.deepEqual(h.errors, []);
  });
}

test("unknown, stream, and empty responses share the stream and total budgets", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-retries": "2" } });
  t.after(h.cleanup);
  h.setResponses([failure(), failure("Unexpected EOF"), fauxAssistantMessage([]), fauxAssistantMessage("unused")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 2);
  assert.deepEqual(h.errors, []);
});

test("the total budget can stop unknown fallback before its separate cap", async (t) => {
  const h = await createHarness({ flags: { "continuity-max-resumes": "1" } });
  t.after(h.cleanup);
  h.setResponses([failure(), failure(), fauxAssistantMessage("unused")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 1);
  assert.deepEqual(h.errors, []);
});

test("unknown fallback preserves raw failure/usage without injecting interrupted context", async (t) => {
  let executions = 0;
  const h = await createHarness({ tools: [{
    name: "finish", label: "Finish", description: "Test tool", parameters: Type.Object({}),
    async execute() {
      executions++;
      return { content: [{ type: "text", text: "finished" }], details: undefined };
    },
  }] });
  t.after(h.cleanup);
  const original = fauxAssistantMessage([
    { type: "thinking", thinking: "safe unfinished reasoning", thinkingSignature: "OPAQUE_SIGNATURE" },
    { type: "thinking", thinking: "REDACTED_THINKING", redacted: true },
    fauxToolCall("finish", { partial: "UNSAFE_ARGUMENTS" }),
  ], { stopReason: "error", errorMessage: '{"detail":"Bad Request"}' });
  h.setResponses([original, fauxAssistantMessage("done")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.equal(executions, 0);
  assert.doesNotMatch(allText(h.requests[1]!), /safe unfinished reasoning|NOT executed/);
  assert.equal(h.checkpoints().length, 0);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /OPAQUE_SIGNATURE|REDACTED_THINKING|UNSAFE_ARGUMENTS/);
  const raw = h.manager.getBranch().find((entry) => entry.type === "message" &&
    entry.message.role === "assistant" && entry.message.stopReason === "error");
  assert.ok(raw?.type === "message" && raw.message.role === "assistant");
  assert.equal(raw.message.errorMessage, original.errorMessage);
  assert.deepEqual(raw.message.content, original.content);
  const emitted = h.events.find((event) => event.type === "message_end" &&
    event.message.role === "assistant" && event.message.stopReason === "error");
  assert.ok(emitted?.type === "message_end" && emitted.message.role === "assistant");
  assert.deepEqual(raw.message.usage, emitted.message.usage);
  assert.ok(raw.message.usage.output > 0);
  assert.deepEqual(h.errors, []);
});

test("unknown fallback budget survives normal tool progress and resets for new user input", async (t) => {
  const h = await createHarness({ flags: { "continuity-unknown-retries": "1" }, tools: [{
    name: "step", label: "Step", description: "Test tool", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "progress" }], details: undefined }; },
  }] });
  t.after(h.cleanup);
  h.setResponses([
    failure(), fauxAssistantMessage(fauxToolCall("step", {}), { stopReason: "toolUse" }),
    failure("Different unrecognized failure"), fauxAssistantMessage("unused"),
  ]);
  await h.session.prompt("First task");
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 1);
  h.setResponses([failure(), fauxAssistantMessage("done")]);
  await h.session.prompt("Second task");
  assert.equal(h.requests.length, 5);
  assert.equal(h.continuations().length, 2);
  assert.deepEqual(h.errors, []);
});

for (const cancel of ["abort", "off", "input"] as const) {
  test(`${cancel} during unknown backoff prevents an extension continuation`, async (t) => {
    const h = await createHarness({ flags: { "continuity-stream-delay-ms": "100" } });
    t.after(h.cleanup);
    let action: Promise<void> | undefined;
    h.setResponses([() => {
      setTimeout(() => {
        action = cancel === "abort" ? h.session.abort() : cancel === "off"
          ? h.session.prompt("/pi-continuity off")
          : h.session.prompt("New instruction", { streamingBehavior: "steer" });
      }, 10);
      return failure();
    }, fauxAssistantMessage("done")]);
    await h.session.prompt("Task");
    await action;
    assert.equal(h.requests.length, cancel === "input" ? 2 : 1);
    assert.equal(h.continuations().length, 0);
    if (cancel === "input") assert.match(allText(h.requests[1]!), /New instruction/);
    assert.deepEqual(h.errors, []);
  });
}

for (const errorMessage of [
  '400 {"detail":"Invalid parameter: temperature"}',
  '400 {"error":{"message":"Missing required parameter: model"}}',
  "422 Unprocessable Entity", "404", "405 Method Not Allowed", "415 Unsupported Media Type",
  "No API key for provider: example", "Access token expired", "Please log in again",
  "Bad Request: permission denied", "Bad Request: content_filter", "Bad Request: insufficient_quota",
  "Request was aborted", "AbortError: This operation was aborted", "User cancelled the request",
  "TypeError: Cannot read properties of undefined", "ReferenceError: missing is not defined",
]) {
  test(`explicit terminal causes still block generic fallback: ${errorMessage}`, async (t) => {
    const h = await createHarness();
    t.after(h.cleanup);
    h.setResponses([failure(errorMessage), fauxAssistantMessage("unused")]);
    await h.session.prompt("Task");
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.equal(h.checkpoints().length, 0);
    assert.deepEqual(h.errors, []);
  });
}

test("unknown recovery waits once at the live boundary, not again at settlement", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-delay-ms": "5000" } });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([failure(), fauxAssistantMessage("done")]);
  const run = h.session.prompt("Task");
  await until(() => clock.pending() > 0);
  clock.advance(4_999);
  assert.equal(h.requests.length, 1);
  clock.advance(1);
  await run;
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 1);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(h.errors, []);
});

test("SDK abort cancels a long unknown backoff immediately without spending its budget", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-delay-ms": "10000" } });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([failure(), fauxAssistantMessage("unused")]);
  const run = h.session.prompt("Task");
  await until(() => clock.pending() > 0);
  await h.session.abort();
  await run;
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(h.errors, []);
});

for (const kind of ["unknown", "stream", "empty"] as const) {
  test(`directly queued SDK input interrupts ${kind} backoff within one poll`, async (t) => {
    const h = await createHarness({ flags: { "continuity-stream-delay-ms": "10000" } });
    t.after(h.cleanup);
    const clock = fakeClock(t);
    h.setResponses([
      kind === "unknown" ? failure() : kind === "stream" ? failure("Unexpected EOF") : fauxAssistantMessage([]),
      fauxAssistantMessage("done"),
    ]);
    const run = h.session.prompt("Task");
    await until(() => clock.pending() > 0);
    await h.session.steer("Direct new instruction");
    clock.advance(1_000);
    await run;
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 0);
    assert.match(allText(h.requests[1]!), /Direct new instruction/);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(h.errors, []);
  });
}

test("unknown recovery respects earlier redaction and preserves other boundary drafts", async (t) => {
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
  h.setResponses([failure("Bad Request", "PRIVATE_SECRET"), fauxAssistantMessage("done")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.doesNotMatch(allText(h.requests[1]!), /PRIVATE_SECRET/);
  assert.doesNotMatch(allText(h.requests[1]!), /\[redacted\]/);
  assert.ok(h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "other-extension"));
  assert.deepEqual(h.errors, []);
});

test("a turn_end continuation cannot suppress recovery after the host hard-exits an error turn", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-delay-ms": "10000" }, before: (pi) => {
    pi.on("turn_end", (event) => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
      return { entries: event.entries, continue: true };
    });
  } });
  t.after(h.cleanup);
  const clock = fakeClock(t);
  h.setResponses([failure(), fauxAssistantMessage("done")]);
  const run = h.session.prompt("Task");
  await until(() => clock.pending() > 0);
  clock.advance(10_000);
  await run;
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 1);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(h.errors, []);
});

test("an earlier settlement continuation is not doubled by unknown fallback", async (t) => {
  const h = await createHarness({ before: (pi) => {
    pi.on("agent_before_settle", (event) => {
      if (event.outcome !== "error") return;
      // The no-prompt policy already omitted the failed assistant at turn_end.
      return { entries: [...event.entries], continue: true };
    });
  } });
  t.after(h.cleanup);
  h.setResponses([failure(), fauxAssistantMessage("done")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.deepEqual(h.errors, []);
});

test("unknown retry limit is explicitly configurable", async (t) => {
  const h = await createHarness({ flags: { "continuity-unknown-retries": "3" } });
  t.after(h.cleanup);
  h.setResponses([failure(), failure(), failure(), fauxAssistantMessage("done")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 4);
  assert.equal(h.continuations().length, 3);
  assert.deepEqual(h.errors, []);
});

test("reasoning-only success gets bounded empty-response recovery", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-retries": "1" } });
  t.after(h.cleanup);
  h.setResponses([
    fauxAssistantMessage({ type: "thinking", thinking: "unfinished plan", thinkingSignature: "OPAQUE_SIGNATURE" }),
    fauxAssistantMessage("done"),
  ]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.doesNotMatch(allText(h.requests[1]!), /unfinished plan/);
  assert.equal(h.checkpoints().length, 0);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /OPAQUE_SIGNATURE/);
  assert.equal(h.continuations().length, 1);
  assert.deepEqual(h.errors, []);
});
