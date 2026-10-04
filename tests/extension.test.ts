import assert from "node:assert/strict";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { allText, createHarness } from "./harness.ts";

const length = (text = "x".repeat(64)) => fauxAssistantMessage(text, { stopReason: "length" });
const broken = (errorMessage = "ECONNRESET", content = "partial plan") =>
  fauxAssistantMessage(content, { stopReason: "error", errorMessage });

function terminalTool(onExecute: () => void, terminate = true): ToolDefinition {
  return {
    name: "finish", label: "Finish", description: "Test tool", parameters: Type.Object({}),
    async execute() {
      onExecute();
      return { content: [{ type: "text", text: "tool finished" }], details: undefined, terminate };
    },
  };
}

test("baseline: Pi alone settles a text length stop at the desired output cap", async (t) => {
  const h = await createHarness({ enabled: false, compaction: true });
  t.after(h.cleanup);
  h.setResponses([length(), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.session.messages.at(-1)?.role, "assistant");
  assert.equal(h.continuations().length, 0);
});

for (const [name, content] of [
  ["text", "x".repeat(64)],
  ["thinking-only", [{ type: "thinking" as const, thinking: "work out the next step", thinkingSignature: "INCOMPLETE_SIGNATURE" }]],
  ["empty", []],
  ["mixed", [fauxThinking("partial thought"), { type: "text" as const, text: "partial answer" }]],
] as const) {
  test(`continues ${name} output truncation and settles only after the follow-up`, async (t) => {
    const h = await createHarness({ compaction: true });
    t.after(h.cleanup);
    const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : [...content];
    h.setResponses([fauxAssistantMessage(blocks, { stopReason: "length" }), fauxAssistantMessage("done")]);
    await h.session.prompt("Finish the task");
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 1);
    assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
    assert.equal(h.events.at(-1)?.type, "agent_settled");
    assert.match(allText(h.requests[1]!), /Continue\./);
    assert.doesNotMatch(JSON.stringify(h.requests[1]), /INCOMPLETE_SIGNATURE/);
    if (name === "thinking-only") assert.match(allText(h.requests[1]!), /work out the next step/);
    if (name === "mixed") assert.match(allText(h.requests[1]!), /partial thought.*partial answer/s);
    assert.equal(h.session.messages.at(-1)?.role, "assistant");
    assert.deepEqual(h.errors, []);
    const original = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "length");
    assert.ok(original, "raw truncated assistant remains in append-only history");
    assert.ok(h.manager.getBranch().some((entry) => entry.type === "context_edit" && entry.targetId === original.id && entry.replacement === null));
  });
}

test("length-truncated tools are never executed; a complete re-issued tool executes once", async (t) => {
  let executed = 0;
  const h = await createHarness({ tools: [terminalTool(() => executed++, false)] });
  t.after(h.cleanup);
  h.setResponses([
    fauxAssistantMessage([fauxThinking("write plan"), fauxToolCall("finish", { incomplete: "UNSAFE_ARGUMENT" })], { stopReason: "length" }),
    fauxAssistantMessage(fauxToolCall("finish", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await h.session.prompt("Finish the task");
  assert.equal(executed, 1);
  assert.equal(h.requests.length, 3);
  assert.match(allText(h.requests[1]!), /NOT executed/);
  assert.match(allText(h.requests[1]!), /write plan/);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /UNSAFE_ARGUMENT/);
  assert.equal(h.requests[1]!.some((message) => message.role === "toolResult"), false);
  assert.equal(h.continuations().length, 1);
  assert.deepEqual(h.errors, []);
});

test("ordinary tool progress gets no extra Continue", async (t) => {
  let executed = 0;
  const h = await createHarness({ tools: [terminalTool(() => executed++, false)] });
  t.after(h.cleanup);
  h.setResponses([fauxAssistantMessage(fauxToolCall("finish", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 2);
  assert.equal(executed, 1);
  assert.equal(h.continuations().length, 0);
  assert.deepEqual(h.errors, []);
});

for (const stopReason of ["stop", "toolUse"] as const) {
  test(`a terminating tool tail (${stopReason}) gets Continue after the tool result`, async (t) => {
    let executed = 0;
    const h = await createHarness({ tools: [terminalTool(() => executed++)] });
    t.after(h.cleanup);
    h.setResponses([
      fauxAssistantMessage([{ type: "text", text: "running" }, fauxToolCall("finish", {})], { stopReason }),
      fauxAssistantMessage("done"),
    ]);
    await h.session.prompt("Finish the task");
    assert.equal(executed, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 1);
    const next = h.requests[1]!;
    const resultIndex = next.findIndex((message) => message.role === "toolResult");
    const continueIndex = next.findIndex((message) => message.role === "user" && allText([message]).startsWith("Continue."));
    assert.ok(resultIndex > 0 && continueIndex > resultIndex);
    assert.deepEqual(h.errors, []);
  });
}

test("tool-tail can be disabled for tools that intentionally terminate the run", async (t) => {
  const h = await createHarness({ flags: { "continuity-tool-tail": "false" }, tools: [terminalTool(() => {})] });
  t.after(h.cleanup);
  h.setResponses([fauxAssistantMessage(fauxToolCall("finish", {}), { stopReason: "toolUse" }), fauxAssistantMessage("unused")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
});

test("native retry gets the readable partial checkpoint without an extra fallback", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  h.setResponses([broken("network connection lost", "preserve this plan"), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 2);
  assert.match(allText(h.requests[1]!), /preserve this plan/);
  assert.equal(h.checkpoints().length, 1);
  assert.equal(h.continuations().length, 0);
  assert.ok(h.events.some((event) => event.type === "auto_retry_start"));
  assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
  assert.deepEqual(h.errors, []);
});

test("extra stream recovery follows exhausted native retries, never races them", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  h.setResponses([broken("fetch failed", "plan one"), broken("fetch failed", "plan two"), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 1);
  assert.equal(h.checkpoints().length, 2);
  assert.match(allText(h.requests[2]!), /plan one.*plan two.*Continue\./s);
  assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
  assert.deepEqual(h.errors, []);
});

test("broader stream classification can recover an EOF not recognized by native retry", async (t) => {
  const h = await createHarness({ nativeRetries: 1 });
  t.after(h.cleanup);
  h.setResponses([broken("Unexpected EOF"), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 1);
  assert.equal(h.events.filter((event) => event.type === "auto_retry_start").length, 0);
});

test("error-reported truncation also resumes without executing its partial tool", async (t) => {
  let executed = 0;
  const h = await createHarness({ tools: [terminalTool(() => executed++)] });
  t.after(h.cleanup);
  h.setResponses([
    fauxAssistantMessage([fauxThinking("unfinished plan"), fauxToolCall("finish", {})], {
      stopReason: "error", errorMessage: "Response truncated: reached max_output_tokens",
    }), fauxAssistantMessage("done"),
  ]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 2);
  assert.equal(executed, 0);
  assert.equal(h.continuations().length, 1);
  assert.match(allText(h.requests[1]!), /unfinished plan/);
});

test("empty successful responses get bounded recovery", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-retries": "1" } });
  t.after(h.cleanup);
  h.setResponses([fauxAssistantMessage([]), fauxAssistantMessage(" "), fauxAssistantMessage("unused")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 1);
});

for (const errorMessage of ["401 invalid API key", "insufficient_quota", "context_length_exceeded", "content_filter", "unknown error"]) {
  test(`no retry/checkpoint for permanent error: ${errorMessage}`, async (t) => {
    const h = await createHarness();
    t.after(h.cleanup);
    h.setResponses([broken(errorMessage), fauxAssistantMessage("unused")]);
    await h.session.prompt("Finish the task");
    assert.equal(h.requests.length, 1);
    assert.equal(h.continuations().length, 0);
    assert.equal(h.checkpoints().length, 0);
  });
}

test("an explicit aborted response never resumes", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  h.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted" }), fauxAssistantMessage("unused")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
});

test("cancellation during the fallback boundary prevents another model request", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-delay-ms": "100" } });
  t.after(h.cleanup);
  let cancel: Promise<void> | undefined;
  h.setResponses([() => {
    setTimeout(() => { cancel = h.session.abort(); }, 10);
    return broken("Unexpected EOF");
  }, fauxAssistantMessage("unused")]);
  await h.session.prompt("Finish the task");
  await cancel;
  assert.equal(h.requests.length, 1);
  assert.equal(h.events.at(-1)?.type, "agent_settled");
});

test("truncation budget spans retries and resets for the next actual user request", async (t) => {
  const h = await createHarness({ flags: { "continuity-max-resumes": "2" } });
  t.after(h.cleanup);
  h.setResponses([length(), length(), length(), fauxAssistantMessage("unused")]);
  await h.session.prompt("First task");
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 2);
  h.setResponses([length(), fauxAssistantMessage("done")]);
  await h.session.prompt("Second task");
  assert.equal(h.requests.length, 5);
  assert.equal(h.continuations().length, 3);
});

test("stream budget is not reset by each native agent_start", async (t) => {
  const h = await createHarness({ nativeRetries: 1, flags: { "continuity-stream-retries": "1" } });
  t.after(h.cleanup);
  h.setResponses([broken("fetch failed"), broken("fetch failed"), broken("fetch failed"), broken("fetch failed"), fauxAssistantMessage("unused")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 4);
  assert.equal(h.continuations().length, 1);
  assert.equal(h.events.filter((event) => event.type === "agent_start").length, 4);
  assert.deepEqual(h.errors, []);
});

test("disabled extension does not alter truncation or failed-stream context", async (t) => {
  const h = await createHarness({ flags: { continuity: "false" } });
  t.after(h.cleanup);
  h.setResponses([length(), fauxAssistantMessage("unused")]);
  await h.session.prompt("First task");
  h.setResponses([broken(), fauxAssistantMessage("unused")]);
  await h.session.prompt("Second task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.equal(h.checkpoints().length, 0);
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "context_edit").length, 0);
});

test("boundary entries from earlier extensions are preserved", async (t) => {
  const h = await createHarness({ before: (pi) => {
    pi.on("turn_end", (event) => ({
      entries: [...event.entries, { type: "custom", customType: "other-extension", data: true }],
    }));
  } });
  t.after(h.cleanup);
  h.setResponses([length(), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "other-extension").length, 2);
  assert.equal(h.continuations().length, 1);
});

test("earlier boundary redaction is not undone by partial recovery", async (t) => {
  const h = await createHarness({ before: (pi) => {
    pi.on("turn_end", (event) => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "length") return;
      return { entries: [...event.entries, { type: "context_edit", targetId: event.messageEntryId, replacement: { content: "[redacted]" } }] };
    });
  } });
  t.after(h.cleanup);
  h.setResponses([length("PRIVATE_SECRET"), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 2);
  assert.doesNotMatch(allText(h.requests[1]!), /PRIVATE_SECRET/);
  assert.match(allText(h.requests[1]!), /\[redacted\]/);
});

test("earlier continuation decision is not doubled", async (t) => {
  const h = await createHarness({ before: (pi) => {
    pi.on("turn_end", (event) => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "length") return;
      return { entries: [...event.entries, { type: "custom_message", customType: "another-continue", content: "Continue once", display: false }], continue: true };
    });
  } });
  t.after(h.cleanup);
  h.setResponses([length(), fauxAssistantMessage("done")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.deepEqual(h.errors, []);
});

test("queued user input replaces the need for an injected Continue", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  h.setResponses([async () => {
    await h.session.prompt("New user instruction", { streamingBehavior: "followUp" });
    return fauxAssistantMessage({ type: "thinking", thinking: "salvage this thought", thinkingSignature: "BROKEN_SIGNATURE" }, { stopReason: "length" });
  }, fauxAssistantMessage("done")]);
  await h.session.prompt("Original instruction");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.match(allText(h.requests[1]!), /New user instruction/);
  assert.match(allText(h.requests[1]!), /salvage this thought/);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /BROKEN_SIGNATURE/);
});

test("normal completion and human-blocked text do not trigger continuation", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  h.setResponses([fauxAssistantMessage("A person must solve the CAPTCHA. I cannot proceed.")]);
  await h.session.prompt("Finish the task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
});
