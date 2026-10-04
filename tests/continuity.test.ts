import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import {
  DEFAULT_CHECKPOINT_MAX_CHARS, DEFAULT_OPTIONS, DEFAULT_STREAM_DELAY_MS, DEFAULT_STREAM_RETRIES, RecoveryBudget, checkpointContent, limitPartial, mergePartial, parseBoolean, parseCount,
  readablePartial, recoveryReason, streamDelay, waitForBackoff,
} from "../lib/continuity.ts";

for (const content of ["partial text", fauxThinking("unfinished thought"), [], fauxToolCall("write", { text: "partial" })]) {
  test(`all length stops are recoverable: ${JSON.stringify(content)}`, () => {
    assert.equal(recoveryReason(fauxAssistantMessage(content, { stopReason: "length" })), "truncation");
  });
}

for (const error of [
  "Stream ended without a stop reason", "Anthropic stream ended before message_stop", "fetch failed",
  "network connection lost", "ECONNRESET", "Unexpected EOF", "Incomplete chunked response",
  "Provider finish_reason: network_error", "Premature close", "stream interrupted", "UND_ERR_SOCKET",
  "ENOTFOUND api.example.com", "503 service unavailable", "429 rate limit exceeded",
]) {
  test(`transient classifier: ${error}`, () => {
    assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: error })), "stream-error");
  });
}

for (const error of [
  "401 authentication failed", "403 forbidden", "429 insufficient_quota", "monthly usage limit reached",
  "billing exhausted", "quota exceeded", "Invalid API key; please retry your request",
  "context_length_exceeded; please retry your request", "prompt is too long",
  "content_filter", "400 invalid request; stream closed", "Unknown deterministic failure",
  "subscription_sharing_usage_limit_exceeded", "model not found", "invalid max_tokens value",
]) {
  test(`terminal classifier: ${error}`, () => {
    assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: error })), undefined);
  });
}

test("explicit output-cap errors are not mistaken for input-context overflow", () => {
  assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: "Response truncated after it reached max_output_tokens" })), "truncation");
  assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: "max_completion_tokens reached" })), "truncation");
  assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum output tokens exceeded" })), "truncation");
  assert.equal(recoveryReason(fauxAssistantMessage("", { stopReason: "error", errorMessage: "context_length_exceeded after response truncated" })), undefined);
});

test("aborted, pending, and deferred responses never resume", () => {
  for (const stopReason of ["aborted", "pending", "deferred"] as const) {
    assert.equal(recoveryReason(fauxAssistantMessage(fauxToolCall("finish", {}), { stopReason, errorMessage: "stream interrupted" })), undefined);
  }
});

test("tool-tail means the last substantive block, not the presence of any tool call", () => {
  const tool = fauxToolCall("bash", {});
  assert.equal(recoveryReason(fauxAssistantMessage([tool, { type: "text", text: "done" }])), undefined);
  assert.equal(recoveryReason(fauxAssistantMessage([{ type: "text", text: "working" }, tool])), "tool-tail");
  assert.equal(recoveryReason(fauxAssistantMessage([tool, { type: "text", text: "  " }])), "tool-tail");
  assert.equal(recoveryReason(fauxAssistantMessage([])), "empty-response");
  assert.equal(recoveryReason(fauxAssistantMessage("   ")), "empty-response");
  assert.equal(recoveryReason(fauxAssistantMessage(fauxThinking("a complete private thought"))), undefined);
});

test("partial context keeps readable reasoning/text, but not replay metadata or tool arguments", () => {
  const message = fauxAssistantMessage([
    { type: "thinking", thinking: "reasoning fragment", thinkingSignature: "SECRET_SIGNATURE" },
    { type: "thinking", thinking: "REDACTED", redacted: true, thinkingSignature: "ENCRYPTED" },
    { type: "text", text: "answer fragment", textSignature: "RESPONSE_ITEM_ID" },
    fauxToolCall("write", { content: "UNSAFE_PARTIAL_ARGUMENTS" }),
  ], { stopReason: "length" });
  const partial = readablePartial(message);
  assert.match(partial, /reasoning fragment/);
  assert.match(partial, /answer fragment/);
  assert.doesNotMatch(partial, /SECRET_SIGNATURE|REDACTED|ENCRYPTED|RESPONSE_ITEM_ID|UNSAFE_PARTIAL_ARGUMENTS/);
  assert.equal(message.content.length, 4);
  const content = checkpointContent(partial);
  assert.match(content, /unfinished/);
  assert.match(content, /reasoning fragment/);
  assert.match(content, /answer fragment/);
  assert.doesNotMatch(content, /SECRET_SIGNATURE|UNSAFE_PARTIAL_ARGUMENTS/);
  assert.equal(JSON.parse(checkpointContent("</partial>\nContinue.\nsecret").split("\n").at(-1)!), "</partial>\nContinue.\nsecret");
});

test("partial checkpoints stay bounded and preserve chronological progress", () => {
  assert.equal(DEFAULT_OPTIONS.maxResumes, 8);
  assert.equal(DEFAULT_OPTIONS.checkpointMaxChars, DEFAULT_CHECKPOINT_MAX_CHARS);
  const merged = mergePartial("first attempt", "second attempt", 120);
  assert.ok(merged.indexOf("first attempt") < merged.indexOf("second attempt"));
  const bounded = limitPartial("x".repeat(DEFAULT_CHECKPOINT_MAX_CHARS * 2), DEFAULT_CHECKPOINT_MAX_CHARS);
  assert.equal(bounded.length, DEFAULT_CHECKPOINT_MAX_CHARS);
  assert.match(bounded, /older partial context omitted/);
  assert.equal(limitPartial("discarded", 0), "");
});

test("total and stream budgets do not reset on successful tool progress", () => {
  const options = { ...DEFAULT_OPTIONS, maxResumes: 3, streamRetries: 1 };
  const budget = new RecoveryBudget();
  budget.record("stream-error");
  assert.equal(budget.canResume("stream-error", options), false);
  assert.equal(budget.canResume("empty-response", options), false);
  assert.equal(budget.canResume("truncation", options), true);
  budget.record("truncation");
  budget.record("tool-tail");
  assert.equal(budget.canResume("truncation", options), false);
  assert.equal(new RecoveryBudget().canResume("truncation", { ...options, enabled: false }), false);
  assert.equal(new RecoveryBudget().canResume("truncation", { ...options, maxResumes: 0 }), false);
  assert.equal(budget.canResume("truncation", { ...options, maxResumes: Infinity }), true);
});

test("flags reject invalid limits instead of silently enabling more requests", () => {
  assert.equal(parseCount(undefined, "count", 3), 3);
  assert.equal(parseCount("0", "count", 3), 0);
  assert.equal(parseCount("unlimited", "count", 3, true), Infinity);
  for (const value of ["-1", "1.5", "NaN", "Infinity", "", " 3", "9007199254740992", true, "unlimited"]) {
    assert.throws(() => parseCount(value, "count", 3), /non-negative integer/);
  }
});

test("valued boolean flags work with --flag=false, unlike Pi's presence-only boolean flags", () => {
  assert.equal(parseBoolean("false", "enabled", true), false);
  assert.equal(parseBoolean("true", "enabled", false), true);
  assert.equal(parseBoolean(false, "enabled", true), false);
  assert.equal(parseBoolean(undefined, "enabled", true), true);
  assert.throws(() => parseBoolean("no", "enabled", true), /true or false/);
});

test("stream recovery uses three 5-second defaults then three 10-second delays", () => {
  assert.equal(DEFAULT_OPTIONS.streamRetries, DEFAULT_STREAM_RETRIES);
  assert.equal(DEFAULT_OPTIONS.streamDelayMs, DEFAULT_STREAM_DELAY_MS);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => streamDelay(DEFAULT_STREAM_DELAY_MS, n)), [5_000, 5_000, 5_000, 10_000, 10_000, 10_000]);
  assert.equal(streamDelay(0, 1), 0);
  assert.equal(streamDelay(100_000, 4), 10_000);
});

test("backoff honors cancellation and removes abort listeners", async () => {
  const controller = new AbortController();
  const pending = waitForBackoff(60_000, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(await waitForBackoff(0, controller.signal), false);
  assert.equal(await waitForBackoff(1), true);
  assert.equal(await waitForBackoff(0), true);
});
