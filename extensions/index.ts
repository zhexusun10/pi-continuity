import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext, SessionBoundaryDraft, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_TYPE, CONTINUATION_TYPE, DEFAULT_CHECKPOINT_MAX_CHARS, DEFAULT_OPTIONS, DEFAULT_STREAM_DELAY_MS, DEFAULT_STREAM_RETRIES,
  MAX_CHECKPOINT_CHARS, RecoveryBudget, USAGE_POLL_DELAY_MS, USAGE_POLL_MAX_ATTEMPTS, USAGE_POLL_WINDOW_MS,
  checkpointContent, limitPartial, mergePartial, parseBoolean, parseCount, readablePartial, recoveryReason, streamDelay, usageLimitDelayMs, waitForBackoff,
  type ContinuityOptions, type RecoveryReason,
} from "../lib/continuity.ts";

interface LastTurn {
  requestId: number;
  message: AssistantMessage;
  entryId: string;
  toolResultIds: string[];
  partial: string;
  resumed: boolean;
  usageWaitCompleted?: boolean;
  usagePoll?: boolean;
}

interface PendingWait {
  controller: AbortController;
  retryAt: number;
}

interface UsagePoll {
  deadline: number;
  attempts: number;
  exhausted: boolean;
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
  let waiting: PendingWait | undefined;
  let usagePoll: UsagePoll | undefined;
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
    waiting?.controller.abort();
    waiting = undefined;
    if (advanceRequestId) requestId++;
    budget = new RecoveryBudget();
    usagePoll = undefined;
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

  /** Bounded 15-minute polling for usage limits without an advertised reset time. */
  function scheduleUsagePoll(ctx: ExtensionContext): number | undefined {
    if (options.maxResumes === 0) return undefined; // 0 disables all extension-scheduled continuations.
    const now = Date.now();
    usagePoll ??= { deadline: now + USAGE_POLL_WINDOW_MS, attempts: 0, exhausted: false };
    const remaining = usagePoll.deadline - now;
    if (usagePoll.attempts >= USAGE_POLL_MAX_ATTEMPTS || remaining <= 0) {
      if (!usagePoll.exhausted) {
        usagePoll.exhausted = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-continuity: usage limit has no reset time after ${USAGE_POLL_WINDOW_MS / 3_600_000} h; giving up.`,
            "warning",
          );
        }
      }
      return undefined;
    }
    usagePoll.attempts++;
    return Math.min(USAGE_POLL_DELAY_MS, remaining);
  }

  /** Wait at `turn_end` while the public abort signal is still live; never wait at settlement. */
  async function waitForLimit(turn: LastTurn, delayMs: number, status: string, ctx: ExtensionContext): Promise<void> {
    const pending = { controller: new AbortController(), retryAt: Date.now() + delayMs };
    waiting = pending;
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", status);
    const signal = ctx.signal ? AbortSignal.any([pending.controller.signal, ctx.signal]) : pending.controller.signal;
    turn.usageWaitCompleted = await waitForBackoff(delayMs, signal, () =>
      last !== turn || !options.enabled || ctx.hasPendingMessages());
    if (waiting === pending) {
      waiting = undefined;
      if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", undefined);
    }
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

  function resume(
    event: TurnEndEvent | AgentBeforeSettleEvent, turn: LastTurn, reason: RecoveryReason, ctx: ExtensionContext, record = true,
  ): BoundaryResult {
    const interrupted = reason !== "tool-tail";
    const baseEntries = interrupted ? omitInterrupted(event.entries, turn) : [...event.entries];
    const unexecutedTools = interrupted
      ? turn.message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
      : [];
    const entries = interrupted
      ? checkpointDraft(event, turn, unexecutedToolsSuffix(unexecutedTools), baseEntries)
      : omitRecoveryArtifacts(baseEntries, event);
    if (record) budget.record(reason);
    turn.resumed = true;
    const attempt = record ? budget.total : usagePoll?.attempts ?? 0;
    entries.push({
      // A plain custom entry records the scheduled attempt without adding user text to the LLM context.
      type: "custom", customType: CONTINUATION_TYPE,
      data: { requestId, reason, attempt, sourceEntryId: turn.entryId, originalStopReason: turn.message.stopReason },
    });
    if (ctx.mode === "tui") {
      ctx.ui.setStatus("pi-continuity", record ? `continuity: ${reason} #${budget.total}` : `continuity: usage-limit poll #${attempt}`);
    }
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
  pi.on("input", () => { waiting?.controller.abort(); });
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
  pi.on("agent_settled", () => { last = undefined; waiting?.controller.abort(); waiting = undefined; });

  pi.on("turn_end", async (event, ctx) => {
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
      const turn = last;
      if (reason === "usage-limit" && !hasOtherWork(event, ctx)) {
        // Wait while the turn still has a live public abort signal. Post-run settlement
        // has no active signal in Pi 1.0.x/1.1.0; waiting there could trap Escape for hours.
        // This also prevents native 429 retries from ignoring the advertised reset time.
        const delayMs = usageLimitDelayMs(turn.message.errorMessage ?? "");
        if (delayMs !== undefined) {
          if (reserve(reason, ctx)) {
            if (ctx.hasUI) ctx.ui.notify(`pi-continuity: provider limit; waiting ${delayMs / 60_000} min before continuing.`, "warning");
            await waitForLimit(turn, delayMs, `continuity: usage limit; retry in ${Math.ceil(delayMs / 60_000)} min`, ctx);
            if (last !== turn || ctx.signal?.aborted) return;
          }
        } else {
          // No advertised reset: poll at a fixed interval within a bounded window.
          const pollDelayMs = scheduleUsagePoll(ctx);
          if (pollDelayMs !== undefined) {
            const attempt = usagePoll?.attempts ?? 0;
            turn.usagePoll = true;
            if (attempt === 1 && ctx.hasUI) {
              ctx.ui.notify(
                `pi-continuity: usage limit has no reset time; polling every ${USAGE_POLL_DELAY_MS / 60_000} min ` +
                  `for up to ${USAGE_POLL_WINDOW_MS / 3_600_000} h.`,
                "warning",
              );
            }
            await waitForLimit(
              turn, pollDelayMs,
              `continuity: usage limit; poll ${attempt}/${USAGE_POLL_MAX_ATTEMPTS} in ${Math.ceil(pollDelayMs / 60_000)} min`,
              ctx,
            );
            if (last !== turn || ctx.signal?.aborted) return;
          }
        }
      }
      // Native retry runs AFTER agent_end and omits the failed assistant. A safe, bounded
      // checkpoint survives that omission and replaces older checkpoints instead of accumulating them.
      const entries = checkpointDraft(event, turn);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    // Normal tool turns continue natively. Do not inject Continue between every call and its answer.
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const turn = last;
    if (!turn || turn.resumed || event.outcome === "aborted" || ctx.signal?.aborted || hasOtherWork(event, ctx)) return;
    const reason = recoveryReason(turn.message);
    if (!reason || !eligible(reason) || (reason === "usage-limit" && !turn.usageWaitCompleted)) return;
    // Polling already authorized its own bounded window at turn_end; it does not consume the resume cap.
    const polled = reason === "usage-limit" && turn.usagePoll === true;
    if (reason === "tool-tail") {
      // A previous extension may already have replaced/omitted the final tool call or added user context.
      const projected = event.context.contextEntries.find((entry) => entry.sourceEntry.id === turn.entryId)
        ?.messages.find((message): message is AssistantMessage => message.role === "assistant");
      if (!projected || recoveryReason(projected) !== "tool-tail" || event.context.llmMessages.at(-1)?.role === "user") return;
    }
    if (!polled && !reserve(reason, ctx)) return;
    if (reason === "stream-error" || reason === "empty-response") {
      const delayMs = streamDelay(options.streamDelayMs, budget.streams + 1);
      const pending = { controller: new AbortController(), retryAt: Date.now() + delayMs };
      waiting = pending;
      const signal = ctx.signal ? AbortSignal.any([pending.controller.signal, ctx.signal]) : pending.controller.signal;
      const completed = await waitForBackoff(delayMs, signal);
      if (waiting === pending) waiting = undefined;
      if (!completed || last !== turn || !options.enabled || ctx.signal?.aborted ||
        event.context.pendingMessages.length > 0 || ctx.hasPendingMessages()) return;
    }
    return resume(event, turn, reason, ctx, !polled);
  });

  pi.registerCommand("pi-continuity", {
    description: "Inspect or toggle recovery: /pi-continuity [status|on|off]",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        options.enabled = action === "on";
        if (!options.enabled) waiting?.controller.abort();
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /pi-continuity [status|on|off]", "warning");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify([
        `pi-continuity: ${options.enabled ? "on" : "off"}; tool-tail ${options.toolTail ? "on" : "off"}`,
        `Last/current user request: ${budget.total}/${options.maxResumes === Infinity ? "unlimited" : options.maxResumes} extra continuations; ${budget.streams}/${options.streamRetries} stream recoveries.`,
        `Truncation ${budget.counts.truncation}; stream errors ${budget.counts["stream-error"]}; usage limits ${budget.counts["usage-limit"]}; empty responses ${budget.counts["empty-response"]}; tool tails ${budget.counts["tool-tail"]}.`,
        ...(waiting ? [`Next recovery in ${Math.max(0, Math.ceil((waiting.retryAt - Date.now()) / 60_000))} min.`] : []),
        ...(usagePoll ? [`Usage-limit polling: ${usagePoll.attempts}/${USAGE_POLL_MAX_ATTEMPTS}; ${
          usagePoll.exhausted ? "gave up" : `gives up in ${Math.max(0, Math.ceil((usagePoll.deadline - Date.now()) / 60_000))} min`
        }.`] : []),
      ].join("\n"), "info");
    },
  });
}
