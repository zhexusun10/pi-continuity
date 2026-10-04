import assert from "node:assert/strict";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarness } from "./harness.ts";

const truncated = () => fauxAssistantMessage("x".repeat(64), { stopReason: "length" });

test("invalid limits fail closed and surface a configuration error", async (t) => {
  const h = await createHarness({ flags: { "continuity-max-resumes": "-1" } });
  t.after(h.cleanup);
  h.setResponses([truncated(), fauxAssistantMessage("unused")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
  assert.match(h.errors[0]!, /continuity-max-resumes/);
});

test("zero total limit disables injected continuations", async (t) => {
  const h = await createHarness({ flags: { "continuity-max-resumes": "0" } });
  t.after(h.cleanup);
  h.setResponses([truncated(), fauxAssistantMessage("unused")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
});

test("unlimited allows more than the default 20 truncation continuations", async (t) => {
  const h = await createHarness({ flags: { "continuity-max-resumes": "unlimited" } });
  t.after(h.cleanup);
  h.setResponses([...Array.from({ length: 22 }, truncated), fauxAssistantMessage("done")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 23);
  assert.equal(h.continuations().length, 22);
  assert.deepEqual(h.errors, []);
});

test("zero stream retry flag leaves native retries unchanged and disables checkpoints", async (t) => {
  const h = await createHarness({ nativeRetries: 1, flags: { "continuity-stream-retries": "0" } });
  t.after(h.cleanup);
  const broken = () => fauxAssistantMessage("fragment", { stopReason: "error", errorMessage: "fetch failed" });
  h.setResponses([broken(), broken(), fauxAssistantMessage("unused")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 2);
  assert.equal(h.continuations().length, 0);
  assert.equal(h.checkpoints().length, 0);
});

test("session commands turn recovery off and back on without submitting their own model prompts", async (t) => {
  const h = await createHarness();
  t.after(h.cleanup);
  await h.session.prompt("/pi-continuity off");
  h.setResponses([truncated(), fauxAssistantMessage("unused")]);
  await h.session.prompt("First task");
  assert.equal(h.requests.length, 1);
  await h.session.prompt("/pi-continuity on");
  h.setResponses([truncated(), fauxAssistantMessage("done")]);
  await h.session.prompt("Second task");
  assert.equal(h.requests.length, 3);
  assert.equal(h.continuations().length, 1);
});

test("turning recovery off during backoff cancels the extension-owned wait", async (t) => {
  const h = await createHarness({ flags: { "continuity-stream-delay-ms": "500" } });
  t.after(h.cleanup);
  let toggle: Promise<void> | undefined;
  h.setResponses([() => {
    setTimeout(() => { toggle = h.session.prompt("/pi-continuity off"); }, 10);
    return fauxAssistantMessage("fragment", { stopReason: "error", errorMessage: "Unexpected EOF" });
  }, fauxAssistantMessage("unused")]);
  await h.session.prompt("Task");
  await toggle;
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
});

test("tool calls followed by substantive final text are not tool tails", async (t) => {
  const h = await createHarness({ tools: [{
    name: "finish", label: "Finish", description: "Terminal test tool", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "result" }], details: undefined, terminate: true }; },
  }] });
  t.after(h.cleanup);
  h.setResponses([fauxAssistantMessage([fauxToolCall("finish", {}), { type: "text", text: "Final answer" }], { stopReason: "toolUse" }), fauxAssistantMessage("unused")]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 1);
  assert.equal(h.continuations().length, 0);
});
