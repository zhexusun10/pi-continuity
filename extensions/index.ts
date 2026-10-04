import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext, SessionBoundaryDraft, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_TYPE, CONTINUATION_TYPE, DEFAULT_OPTIONS, RecoveryBudget,
  checkpointContent, continuationContent, parseBoolean, parseCount, readablePartial, recoveryReason, streamDelay, waitForBackoff,
  type ContinuityOptions, type RecoveryReason,
} from "../lib/continuity.ts";

interface LastTurn {
  message: AssistantMessage;
  entryId: string;
  toolResultIds: string[];
  partial: string;
  checkpointed: boolean;
  resumed: boolean;
}

/** Public boundary hooks only. No direct provider calls, file I/O, or core patches. */
export default function piContinuity(pi: ExtensionAPI): void {
  let options: ContinuityOptions = { ...DEFAULT_OPTIONS };
  let budget = new RecoveryBudget();
  let last: LastTurn | undefined;
  let waiting: AbortController | undefined;
  let warned = false;

  // Pi's boolean CLI flags are presence-only; strings allow explicit --flag=false.
  pi.registerFlag("continuity", { type: "string", default: "true", description: "Enable recovery (true|false)" });
  pi.registerFlag("continuity-max-resumes", {
    type: "string", default: "20", description: "Extra continuations per user request (integer or unlimited)",
  });
  pi.registerFlag("continuity-stream-retries", {
    type: "string", default: "3", description: "Extra stream recoveries after native retries (0 disables)",
  });
  pi.registerFlag("continuity-stream-delay-ms", {
    type: "string", default: "1000", description: "Stream recovery backoff base in ms (capped at 8000)",
  });
  pi.registerFlag("continuity-tool-tail", {
    type: "string", default: "true", description: "Continue a settled tool-call ending (true|false)",
  });

  function reset(ctx: ExtensionContext): void {
    waiting?.abort();
    waiting = undefined;
    budget = new RecoveryBudget();
    last = undefined;
    warned = false;
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", undefined);
  }

  function eligible(reason: RecoveryReason): boolean {
    return options.enabled && (reason !== "tool-tail" || options.toolTail) &&
      ((reason !== "stream-error" && reason !== "empty-response") || options.streamRetries > 0);
  }

  function hasOtherWork(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext): boolean {
    return event.continue || event.context.pendingMessages.length > 0 || ctx.hasPendingMessages();
  }

  function reserve(reason: RecoveryReason, ctx: ExtensionContext): boolean {
    if (budget.canResume(reason, options)) return true;
    if (!warned) {
      warned = true;
      if (ctx.hasUI) ctx.ui.notify("pi-continuity: recovery budget exhausted. Inspect the task before continuing manually.", "warning");
      if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", "continuity: budget exhausted");
    }
    return false;
  }

  function omitInterrupted(entries: SessionBoundaryDraft[], turn: LastTurn): SessionBoundaryDraft[] {
    // Keep raw history/usage intact, but don't replay broken signed reasoning or orphan tool calls.
    return [...entries, ...[turn.entryId, ...turn.toolResultIds].map((targetId): SessionBoundaryDraft => ({
      type: "context_edit", targetId, replacement: null,
    }))];
  }

  function resume(event: TurnEndEvent | AgentBeforeSettleEvent, turn: LastTurn, reason: RecoveryReason, ctx: ExtensionContext): BoundaryResult {
    const interrupted = reason === "truncation" || reason === "stream-error";
    const entries = interrupted ? omitInterrupted(event.entries, turn) : [...event.entries];
    const unexecutedTools = interrupted
      ? turn.message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
      : [];
    budget.record(reason);
    turn.resumed = true;
    entries.push({
      type: "custom_message", customType: CONTINUATION_TYPE, display: false,
      content: continuationContent(reason, interrupted && !turn.checkpointed ? turn.partial : "", unexecutedTools),
      details: { reason, attempt: budget.total, sourceEntryId: turn.entryId, originalStopReason: turn.message.stopReason },
    });
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", `continuity: ${reason} #${budget.total}`);
    return { entries, continue: true };
  }

  pi.on("session_start", (_event, ctx) => {
    reset(ctx);
    try {
      options = {
        enabled: parseBoolean(pi.getFlag("continuity"), "continuity", true),
        toolTail: parseBoolean(pi.getFlag("continuity-tool-tail"), "continuity-tool-tail", true),
        maxResumes: parseCount(pi.getFlag("continuity-max-resumes"), "continuity-max-resumes", 20, true),
        streamRetries: parseCount(pi.getFlag("continuity-stream-retries"), "continuity-stream-retries", 3),
        streamDelayMs: parseCount(pi.getFlag("continuity-stream-delay-ms"), "continuity-stream-delay-ms", 1_000),
      };
    } catch (error) {
      options.enabled = false; // Fail closed; do not silently use a different spending limit.
      throw error;
    }
  });
  pi.on("before_agent_start", (_event, ctx) => reset(ctx));
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") reset(ctx); // Includes queued user follow-ups, excludes our custom messages.
  });
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("agent_settled", () => { last = undefined; waiting?.abort(); waiting = undefined; });

  pi.on("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    // Respect earlier boundary redactions/omissions instead of rescuing the unedited raw content.
    const projected = event.context.contextEntries.find((entry) => entry.sourceEntry.id === event.messageEntryId)
      ?.messages.find((message): message is AssistantMessage => message.role === "assistant");
    last = {
      message: projected ?? { ...event.message, content: [] }, entryId: event.messageEntryId,
      toolResultIds: event.toolResultEntryIds, partial: projected ? readablePartial(projected) : "",
      checkpointed: false, resumed: false,
    };
    const reason = recoveryReason(last.message);
    if (!reason || !eligible(reason) || event.outcome === "aborted" || ctx.signal?.aborted) return;
    if (reason === "truncation" && last.message.stopReason === "length") {
      if (hasOtherWork(event, ctx)) {
        // Existing user input/another continuation already supplies the next request. Still sanitize
        // the truncated protocol content so reasoning-only fragments cannot poison that request.
        const tools = last.message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
        return { entries: [...omitInterrupted(event.entries, last), {
          type: "custom_message", customType: CHECKPOINT_TYPE, display: false,
          content: checkpointContent(last.partial) + (tools.length ? "\nUnexecuted tool names: " + JSON.stringify(tools) : ""),
          details: { sourceEntryId: last.entryId },
        }] };
      }
      if (reserve(reason, ctx)) return resume(event, last, reason, ctx);
      return;
    }
    if (last.message.stopReason === "error" && last.partial) {
      // Native retry runs AFTER agent_end and omits the failed assistant. A safe text checkpoint
      // survives that omission, so even native retries can use the readable partial reasoning.
      last.checkpointed = true;
      return {
        entries: [...event.entries, {
          type: "custom_message", customType: CHECKPOINT_TYPE, display: false,
          content: checkpointContent(last.partial), details: { sourceEntryId: last.entryId },
        }],
      };
    }
    // Normal tool turns continue natively. Do not inject Continue between every call and its answer.
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const turn = last;
    if (!turn || turn.resumed || event.outcome === "aborted" || ctx.signal?.aborted || hasOtherWork(event, ctx)) return;
    const reason = recoveryReason(turn.message);
    if (!reason || !eligible(reason)) return;
    if (reason === "tool-tail") {
      // A previous extension may already have replaced/omitted the final tool call or added user context.
      const projected = event.context.contextEntries.find((entry) => entry.sourceEntry.id === turn.entryId)
        ?.messages.find((message): message is AssistantMessage => message.role === "assistant");
      if (!projected || recoveryReason(projected) !== "tool-tail" || event.context.llmMessages.at(-1)?.role === "user") return;
    }
    if (!reserve(reason, ctx)) return;
    if (reason === "stream-error" || reason === "empty-response") {
      const controller = new AbortController();
      waiting = controller;
      const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
      const completed = await waitForBackoff(streamDelay(options.streamDelayMs, budget.streams + 1), signal);
      if (waiting === controller) waiting = undefined;
      if (!completed || last !== turn || !options.enabled || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    }
    return resume(event, turn, reason, ctx);
  });

  pi.registerCommand("pi-continuity", {
    description: "Inspect or toggle recovery: /pi-continuity [status|on|off]",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        options.enabled = action === "on";
        if (!options.enabled) waiting?.abort();
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /pi-continuity [status|on|off]", "warning");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify([
        `pi-continuity: ${options.enabled ? "on" : "off"}; tool-tail ${options.toolTail ? "on" : "off"}`,
        `Last/current user request: ${budget.total}/${options.maxResumes === Infinity ? "unlimited" : options.maxResumes} extra continuations; ${budget.streams}/${options.streamRetries} stream recoveries.`,
        `Truncation ${budget.counts.truncation}; stream errors ${budget.counts["stream-error"]}; empty responses ${budget.counts["empty-response"]}; tool tails ${budget.counts["tool-tail"]}.`,
      ].join("\n"), "info");
    },
  });
}
