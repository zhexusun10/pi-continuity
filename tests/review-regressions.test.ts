import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, limitPartial, mergePartial, recoveryReason } from "../lib/continuity.ts";
import { allText, createHarness } from "./harness.ts";

const failed = (errorMessage: string, text = "partial progress") =>
  fauxAssistantMessage(text, { stopReason: "error", errorMessage });

test("every small checkpoint cap is a hard bound, including zero-length tails", () => {
  const text = "HEAD_" + "x".repeat(1_000) + "_TAIL";
  for (let cap = 0; cap <= 150; cap++) {
    assert.ok(limitPartial(text, cap).length <= cap, `limitPartial exceeded cap ${cap}`);
    assert.ok(mergePartial(text, "more progress", cap).length <= cap, `mergePartial exceeded cap ${cap}`);
  }
});

for (const errorMessage of [
  "ERR_HTTP2_STREAM_CANCEL: The pending stream has been canceled (caused by: socket hang up)",
  "ERR_HTTP2_STREAM_CANCEL: The pending stream has been cancelled",
  "stream cancelled by the upstream server",
]) {
  test(`transport cancellation must not be mistaken for user cancellation: ${errorMessage}`, () => {
    assert.equal(recoveryReason(failed(errorMessage)), "stream-error");
  });
}

for (const errorMessage of [
  "aborted", "Error: aborted", "User aborted the request", "Cancelled by user",
  "Request was cancelled", "The operation was canceled.",
]) {
  test(`explicit user/request cancellation remains terminal: ${errorMessage}`, () => {
    assert.equal(recoveryReason(failed(errorMessage)), undefined);
  });
}

for (const errorMessage of [
  "fetch failed; request_id=404", "Unexpected EOF after 422 bytes", "HTTP 503; request_id=401",
  '{"request_id":"413","detail":"Bad Request"}',
]) {
  test(`non-status numbers cannot trigger terminal HTTP classification: ${errorMessage}`, () => {
    assert.equal(recoveryReason(failed(errorMessage)), errorMessage.includes("Bad Request") ? "unknown-error" : "stream-error");
  });
}

for (const errorMessage of [
  "404", "Error: 404", "HTTP 422", "HTTP/1.1 415 Unsupported Media Type",
  'Provider API error (403): {"detail":"denied"}', '{"statusCode":422,"detail":"Bad Request"}',
  "HTTP status: 405", "status code 410",
]) {
  test(`explicit HTTP status remains terminal: ${errorMessage}`, () => {
    assert.equal(recoveryReason(failed(errorMessage)), undefined);
  });
}

for (const flag of ["continuity-max-resumes", "continuity-stream-retries", "continuity-unknown-retries"]) {
  test(`/pi-continuity on cannot bypass invalid ${flag}`, async (t) => {
    const h = await createHarness({ flags: { [flag]: "-1" } });
    t.after(h.cleanup);
    h.setResponses([failed("Bad Request"), fauxAssistantMessage("unused")]);
    await h.session.prompt("First task");
    assert.equal(h.requests.length, 1);
    assert.match(h.errors[0]!, new RegExp(flag));
    await h.session.prompt("/pi-continuity on");
    h.setResponses([failed("Bad Request"), fauxAssistantMessage("unused")]);
    await h.session.prompt("Second task");
    assert.equal(h.requests.length, 2);
    assert.equal(h.continuations().length, 0);
  });
}

for (const mode of ["redact", "omit"] as const) {
  for (const nativeRetries of [0, 1]) {
    test(`settlement ${mode} of original and checkpoint is not undone (${nativeRetries} native retries)`, async (t) => {
      const h = await createHarness({ nativeRetries, before: (pi) => {
        pi.on("agent_before_settle", (event) => {
          const edits = event.context.contextEntries.flatMap((entry): SessionBoundaryDraft[] => {
            if (entry.messages.length === 0) return [];
            const source = entry.sourceEntry;
            if ((source.type === "custom_message" && source.customType === CHECKPOINT_TYPE) ||
              (source.type === "message" && source.message.role === "assistant" && source.message.stopReason === "error")) {
              return [{ type: "context_edit", targetId: source.id,
                replacement: mode === "omit" ? null : { content: "[redacted]" } }];
            }
            return [];
          });
          return edits.length ? { entries: [...event.entries, ...edits] } : undefined;
        });
      } });
      t.after(h.cleanup);
      h.setResponses([
        ...Array.from({ length: nativeRetries + 1 }, () => failed("fetch failed", "PRIVATE_SECRET")),
        fauxAssistantMessage("done"),
      ]);
      await h.session.prompt("Task");
      assert.equal(h.requests.length, nativeRetries + 2);
      assert.doesNotMatch(allText(h.requests.at(-1)!), /PRIVATE_SECRET/);
      assert.equal(h.continuations().length, 1);
      assert.ok(h.manager.getBranch().some((entry) => entry.type === "message" &&
        entry.message.role === "assistant" && entry.message.stopReason === "error" &&
        entry.message.content.some((block) => block.type === "text" && block.text === "PRIVATE_SECRET")));
      assert.deepEqual(h.errors, []);
    });
  }
}

for (const maxResumes of ["0", "1"]) {
  test(`native truncated-tool continuation has no orphan results after total cap ${maxResumes}`, async (t) => {
    let executed = 0;
    const h = await createHarness({ flags: { "continuity-max-resumes": maxResumes }, tools: [{
      name: "step", label: "Step", description: "Test tool", parameters: Type.Object({}),
      async execute() { executed++; return { content: [{ type: "text", text: "done" }], details: undefined }; },
    }] });
    t.after(h.cleanup);
    h.setResponses([
      ...(maxResumes === "1" ? [fauxAssistantMessage("first progress", { stopReason: "length" })] : []),
      fauxAssistantMessage(fauxToolCall("step", { partial: "UNSAFE_ARGUMENTS" }), { stopReason: "length" }),
      fauxAssistantMessage("done"),
    ]);
    await h.session.prompt("Task");
    const next = h.requests.at(-1)!;
    const callIds = new Set(next.flatMap((message) => message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : []));
    for (const message of next) {
      if (message.role === "toolResult") assert.ok(callIds.has(message.toolCallId), "tool result has no matching assistant call");
    }
    assert.equal(h.requests.length, Number(maxResumes) + 2);
    assert.equal(h.continuations().length, Number(maxResumes));
    if (maxResumes === "1") {
      assert.doesNotMatch(JSON.stringify(next), /UNSAFE_ARGUMENTS/);
      assert.doesNotMatch(allText(next), /NOT executed/);
    }
    assert.equal(executed, 0);
    assert.deepEqual(h.errors, []);
  });
}

test("content-edited checkpoints are eventually retired instead of staying active forever", async (t) => {
  const h = await createHarness({ before: (pi) => {
    pi.on("turn_end", (event) => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
      const edits = event.context.contextEntries.flatMap((entry): SessionBoundaryDraft[] =>
        entry.messages.length > 0 && entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === CHECKPOINT_TYPE
          ? [{ type: "context_edit", targetId: entry.sourceEntry.id, replacement: { content: "[redacted old checkpoint]" } }]
          : []);
      return edits.length ? { entries: [...event.entries, ...edits] } : undefined;
    });
  } });
  t.after(h.cleanup);
  h.manager.appendCustomMessageEntry(CHECKPOINT_TYPE, "PRIVATE_OLD_PROGRESS", false, { partial: "PRIVATE_OLD_PROGRESS" });
  h.setResponses([
    failed("Bad Request", "PRIVATE_OLD_PROGRESS"), failed("Bad Request", "new progress"),
    fauxAssistantMessage("done"),
  ]);
  await h.session.prompt("Task");
  assert.equal(h.requests.length, 3);
  assert.doesNotMatch(allText(h.requests[2]!), /PRIVATE_OLD_PROGRESS/);
  assert.doesNotMatch(JSON.stringify(h.manager.buildSessionProjection().messages), /redacted old checkpoint/);
  assert.deepEqual(h.errors, []);
});
