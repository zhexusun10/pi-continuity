import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext, SessionBoundaryDraft, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_TYPE, CONTINUATION_TYPE, DEFAULT_CHECKPOINT_MAX_CHARS, DEFAULT_OPTIONS, DEFAULT_STREAM_DELAY_MS, DEFAULT_STREAM_RETRIES,
  MAX_CHECKPOINT_CHARS, RecoveryBudget,
  checkpointContent, limitPartial, mergePartial, parseBoolean, parseCount, readablePartial, recoveryReason, streamDelay, waitForBackoff,
  type ContinuityOptions, type RecoveryReason,
} from "../lib/continuity.ts";

interface LastTurn {
  requestId: number;
  message: AssistantMessage;
  entryId: string;
  toolResultIds: string[];
  partial: string;
  resumed: boolean;
}

interface RecoveryArtifact {
  id: string;
  kind: "checkpoint" | "continuation";
  partial: string;
  requestId?: number;
}

interface CheckpointDetails {
  requestId: number;
  sourceEntryId: string;
  partial: string;
}

/** Public boundary hooks only. No direct provider calls, file I/O, or core patches. */
export default function piContinuity(pi: ExtensionAPI): void {
  let options: ContinuityOptions = { ...DEFAULT_OPTIONS };
  let budget = new RecoveryBudget();
  let requestId = 0;
  let firstRequestAfterSession = false;
  let last: LastTurn | undefined;
  let waiting: AbortController | undefined;
  let warned = false;

  // Pi's boolean CLI flags are presence-only; strings allow explicit --flag=false.
  pi.registerFlag("continuity", { type: "string", default: "true", description: "Enable recovery (true|false)" });
  pi.registerFlag("continuity-max-resumes", {
    type: "string", default: "8", description: "Extra continuations per user request (integer or unlimited)",
  });
  pi.registerFlag("continuity-stream-retries", {
    type: "string", default: String(DEFAULT_STREAM_RETRIES), description: "Extra stream recoveries after native retries (0 disables)",
  });
  pi.registerFlag("continuity-stream-delay-ms", {
    type: "string", default: String(DEFAULT_STREAM_DELAY_MS), description: "Stream recovery delay in ms; first 3 use the base, later attempts use 2x (capped at 10000)",
  });
  pi.registerFlag("continuity-checkpoint-max-chars", {
    type: "string", default: String(DEFAULT_CHECKPOINT_MAX_CHARS),
    description: "Maximum merged partial context characters (0 disables partial context)",
  });
  pi.registerFlag("continuity-tool-tail", {
    type: "string", default: "true", description: "Continue a settled tool-call ending (true|false)",
  });

  function reset(ctx: ExtensionContext, advanceRequestId = true, preserveLast = false): void {
    waiting?.abort();
    waiting = undefined;
    if (advanceRequestId) requestId++;
    budget = new RecoveryBudget();
    if (!preserveLast) last = undefined;
    warned = false;
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", undefined);
  }

  function eligible(reason: RecoveryReason): boolean {
    return options.enabled && (reason !== "tool-tail" || options.toolTail) &&
      ((reason !== "stream-error" && reason !== "empty-response") || options.streamRetries > 0);
  }

  function parseCheckpointMaxChars(): number {
    const value = parseCount(
      pi.getFlag("continuity-checkpoint-max-chars"), "continuity-checkpoint-max-chars", DEFAULT_CHECKPOINT_MAX_CHARS,
    );
    if (value > MAX_CHECKPOINT_CHARS) {
      throw new Error(`--continuity-checkpoint-max-chars must be at most ${MAX_CHECKPOINT_CHARS}.`);
    }
    return value;
  }

  function hasOtherWork(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext): boolean {
    return event.continue || event.context.pendingMessages.length > 0 || ctx.hasPendingMessages();
  }

  function detailsFromUnknown(details: unknown): { requestId?: number; partial: string } {
    if (typeof details !== "object" || details === null) return { partial: "" };
    const record = details as Record<string, unknown>;
    return {
      requestId: typeof record.requestId === "number" ? record.requestId : undefined,
      partial: typeof record.partial === "string" ? record.partial : "",
    };
  }

  function recoveryArtifacts(event: TurnEndEvent | AgentBeforeSettleEvent): RecoveryArtifact[] {
    return event.context.contextEntries.flatMap((entry): RecoveryArtifact[] => {
      if (entry.messages.length === 0) return [];
      const source = entry.sourceEntry;
      if (source.type !== "custom_message") return [];
      if (source.customType === CHECKPOINT_TYPE) {
        const details = detailsFromUnknown(source.details);
        return [{ id: source.id, kind: "checkpoint" as const, ...details }];
      }
      if (source.customType === CONTINUATION_TYPE) {
        const details = detailsFromUnknown(source.details);
        return [{ id: source.id, kind: "continuation" as const, ...details }];
      }
      return [];
    });
  }

  function omitRecoveryArtifacts(
    entries: SessionBoundaryDraft[],
    event: TurnEndEvent | AgentBeforeSettleEvent,
  ): SessionBoundaryDraft[] {
    const alreadyEdited = new Set([
      ...entries.flatMap((entry) => entry.type === "context_edit" ? [entry.targetId] : []),
      ...event.context.contextEntries.flatMap((entry) =>
        entry.sourceEntry.type === "context_edit" ? [entry.sourceEntry.targetId] : []),
    ]);
    const edits = recoveryArtifacts(event)
      .filter((artifact) => !alreadyEdited.has(artifact.id))
      .map((artifact): SessionBoundaryDraft => ({ type: "context_edit", targetId: artifact.id, replacement: null }));
    return [...entries, ...edits];
  }

  function checkpointDraft(
    event: TurnEndEvent | AgentBeforeSettleEvent,
    turn: LastTurn,
    suffix = "",
    baseEntries = event.entries,
  ): SessionBoundaryDraft[] {
    const priorPartial = recoveryArtifacts(event)
      .filter((artifact) => artifact.requestId === requestId && artifact.partial)
      .reduce((merged, artifact) => mergePartial(merged, artifact.partial, options.checkpointMaxChars), "");
    const partial = mergePartial(priorPartial, turn.partial, options.checkpointMaxChars);
    const entries = omitRecoveryArtifacts(baseEntries, event);
    if (!partial && !suffix) return entries;
    const content = partial
      ? checkpointContent(partial, options.checkpointMaxChars) + suffix
      : "The preceding provider response was interrupted. No readable partial assistant context was available." + suffix;
    const details: CheckpointDetails = { requestId, sourceEntryId: turn.entryId, partial };
    return [...entries, {
      type: "custom_message", customType: CHECKPOINT_TYPE, display: false, content, details,
    }];
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

  function unexecutedToolsSuffix(toolNames: string[]): string {
    return toolNames.length ? "\nCalls in the interrupted response were NOT executed. Re-issue any still needed " +
      "with complete arguments; do not treat partial calls as results. Tool names: " + JSON.stringify(toolNames) : "";
  }

  function resume(event: TurnEndEvent | AgentBeforeSettleEvent, turn: LastTurn, reason: RecoveryReason, ctx: ExtensionContext): BoundaryResult {
    const interrupted = reason === "truncation" || reason === "stream-error" || reason === "empty-response";
    const baseEntries = interrupted ? omitInterrupted(event.entries, turn) : [...event.entries];
    const unexecutedTools = reason === "truncation" || reason === "stream-error"
      ? turn.message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
      : [];
    const entries = reason === "truncation" || reason === "stream-error" || reason === "empty-response"
      ? checkpointDraft(event, turn, unexecutedToolsSuffix(unexecutedTools), baseEntries)
      : omitRecoveryArtifacts(baseEntries, event);
    budget.record(reason);
    turn.resumed = true;
    entries.push({
      // A plain custom entry records the scheduled attempt without adding user text to the LLM context.
      type: "custom", customType: CONTINUATION_TYPE,
      data: { requestId, reason, attempt: budget.total, sourceEntryId: turn.entryId, originalStopReason: turn.message.stopReason },
    });
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", `continuity: ${reason} #${budget.total}`);
    return { entries, continue: true };
  }

  pi.on("session_start", (_event, ctx) => {
    reset(ctx);
    firstRequestAfterSession = true;
    try {
      options = {
        enabled: parseBoolean(pi.getFlag("continuity"), "continuity", true),
        toolTail: parseBoolean(pi.getFlag("continuity-tool-tail"), "continuity-tool-tail", true),
        maxResumes: parseCount(pi.getFlag("continuity-max-resumes"), "continuity-max-resumes", 8, true),
        streamRetries: parseCount(pi.getFlag("continuity-stream-retries"), "continuity-stream-retries", DEFAULT_STREAM_RETRIES),
        streamDelayMs: parseCount(pi.getFlag("continuity-stream-delay-ms"), "continuity-stream-delay-ms", DEFAULT_STREAM_DELAY_MS),
        checkpointMaxChars: parseCheckpointMaxChars(),
      };
    } catch (error) {
      options.enabled = false; // Fail closed; do not silently use a different spending limit.
      throw error;
    }
  });
  pi.on("before_agent_start", (_event, ctx) => reset(ctx));
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") {
      const queuedDuringRun = !ctx.isIdle() && last !== undefined;
      reset(ctx, !queuedDuringRun, queuedDuringRun);
    }
  });
  pi.on("context", (event) => {
    if (!options.enabled) return;
    // Context edits clean the persisted branch at the next boundary. This hook also prevents
    // stale artifacts from a previous user request entering the very first prompt of a new one.
    const lastUserIndex = event.messages.findLastIndex((message) => message.role === "user");
    return { messages: event.messages.filter((message, index) => {
      if (message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "length" || message.stopReason === "aborted")) {
        // Failed/incomplete assistant protocol blocks are unsafe to replay. Their readable
        // progress, when eligible, is represented by our bounded checkpoint instead.
        return false;
      }
      if (message.role !== "custom" || (message.customType !== CHECKPOINT_TYPE && message.customType !== CONTINUATION_TYPE)) {
        return true;
      }
      const artifactRequestId = detailsFromUnknown(message.details).requestId;
      return (last !== undefined && artifactRequestId === last.requestId) ||
        (firstRequestAfterSession && index > lastUserIndex);
    }) };
  });
  pi.on("session_tree", (_event, ctx) => {
    firstRequestAfterSession = false;
    reset(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("agent_settled", () => { last = undefined; waiting?.abort(); waiting = undefined; });

  pi.on("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    firstRequestAfterSession = false;
    const projected = event.context.contextEntries.find((entry) => entry.sourceEntry.id === event.messageEntryId)
      ?.messages.find((message): message is AssistantMessage => message.role === "assistant");
    last = {
      requestId,
      message: projected ?? { ...event.message, content: [] }, entryId: event.messageEntryId,
      toolResultIds: event.toolResultEntryIds,
      partial: projected ? limitPartial(readablePartial(projected), options.checkpointMaxChars) : "",
      resumed: false,
    };
    const reason = recoveryReason(last.message);
    if (event.outcome === "aborted" || ctx.signal?.aborted) return;
    if (!reason || !eligible(reason)) {
      // A successful response or an opted-out terminal response makes earlier recovery
      // artifacts stale. Omit them from future model context while retaining raw history.
      const entries = omitRecoveryArtifacts(event.entries, event);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    if (reason === "truncation" && last.message.stopReason === "length") {
      if (hasOtherWork(event, ctx)) {
        // Existing user input/another continuation already supplies the next request. Still sanitize
        // the truncated protocol content so reasoning-only fragments cannot poison that request.
        const suffix = unexecutedToolsSuffix(last.message.content.filter((block) => block.type === "toolCall").map((block) => block.name));
        const entries = checkpointDraft(event, last, suffix, omitInterrupted(event.entries, last));
        return { entries };
      }
      if (reserve(reason, ctx)) return resume(event, last, reason, ctx);
      return;
    }
    if (last.message.stopReason === "error") {
      // Native retry runs AFTER agent_end and omits the failed assistant. A safe, bounded
      // checkpoint survives that omission and replaces older checkpoints instead of accumulating them.
      const entries = checkpointDraft(event, last);
      return entries.length > event.entries.length ? { entries } : undefined;
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
      if (!completed || last !== turn || !options.enabled || ctx.signal?.aborted ||
        event.context.pendingMessages.length > 0 || ctx.hasPendingMessages()) return;
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
