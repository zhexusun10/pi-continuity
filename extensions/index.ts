import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext, SessionBoundaryDraft, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_TYPE, CONTINUATION_TYPE, DEFAULT_CHECKPOINT_MAX_CHARS, DEFAULT_OPTIONS, DEFAULT_STREAM_DELAY_MS, DEFAULT_STREAM_RETRIES,
  DEFAULT_UNKNOWN_RETRIES, EXTENDED_USAGE_POLL_WINDOW_MS, MAX_CHECKPOINT_CHARS, RecoveryBudget, USAGE_POLL_DELAY_MS, USAGE_POLL_WINDOW_MS,
  formatDelayMs, parseBoolean, parseCount, recoveryReason, retryDelayMs, streamDelay, usesStreamBudget, waitForBackoff,
  type ContinuityOptions, type RecoveryReason,
} from "../lib/continuity.ts";

interface LastTurn {
  message: AssistantMessage;
  entryId: string;
  toolResultIds: string[];
  resumed: boolean;
  usageWaitCompleted?: boolean;
  fallbackWaitCompleted?: boolean;
  inputInterrupted?: boolean;
  usagePoll?: boolean;
}

interface PendingWait {
  controller: AbortController;
  retryAt: number;
}

interface UsagePoll {
  deadline: number;
  attempts: number;
  maxAttempts: number;
  windowMs: number;
  exhausted: boolean;
}

type BoundaryEvent = TurnEndEvent | AgentBeforeSettleEvent;

/** Public boundary hooks only. No provider calls, file I/O, core patches, or model-visible prompt injection. */
export default function piContinuity(pi: ExtensionAPI): void {
  let options: ContinuityOptions = { ...DEFAULT_OPTIONS };
  let configurationValid = false;
  let budget = new RecoveryBudget();
  let requestId = 0;
  let last: LastTurn | undefined;
  let waiting: PendingWait | undefined;
  let usagePoll: UsagePoll | undefined;
  let usagePollExhaustions = 0;
  let warned = false;

  // Pi's boolean CLI flags are presence-only; strings allow explicit --flag=false.
  pi.registerFlag("continuity", { type: "string", default: "true", description: "Enable recovery (true|false)" });
  pi.registerFlag("continuity-max-resumes", {
    type: "string", default: "16", description: "Extra continuations per user request (integer or unlimited)",
  });
  pi.registerFlag("continuity-stream-retries", {
    type: "string", default: String(DEFAULT_STREAM_RETRIES), description: "Shared stream/empty/unknown recovery cap after native retries (0 disables)",
  });
  pi.registerFlag("continuity-unknown-retries", {
    type: "string", default: String(DEFAULT_UNKNOWN_RETRIES),
    description: "Extra recoveries for undiagnosed errors (also bounded by stream/total caps; 0 disables)",
  });
  pi.registerFlag("continuity-stream-delay-ms", {
    type: "string", default: String(DEFAULT_STREAM_DELAY_MS),
    description: "Live recovery delay in ms; first 3 use the base, later attempts use 2x (capped at 10000)",
  });
  pi.registerFlag("continuity-checkpoint-max-chars", {
    type: "string", default: String(DEFAULT_CHECKPOINT_MAX_CHARS), description: "Deprecated no-op; checkpoint text is never injected",
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
    return options.enabled && options.maxResumes > 0 && (reason !== "tool-tail" || options.toolTail) &&
      (!usesStreamBudget(reason) || options.streamRetries > 0) &&
      (reason !== "unknown-error" || options.unknownRetries > 0);
  }

  /** Validate the deprecated flag so old scripts keep the same fail-closed behavior. */
  function parseCheckpointMaxChars(): number {
    const value = parseCount(
      pi.getFlag("continuity-checkpoint-max-chars"), "continuity-checkpoint-max-chars", DEFAULT_CHECKPOINT_MAX_CHARS,
    );
    if (value > MAX_CHECKPOINT_CHARS) throw new Error(`--continuity-checkpoint-max-chars must be at most ${MAX_CHECKPOINT_CHARS}.`);
    return value;
  }

  function hasQueuedWork(event: BoundaryEvent, ctx: ExtensionContext): boolean {
    return event.context.pendingMessages.length > 0 || ctx.hasPendingMessages();
  }

  function hasOtherWork(event: BoundaryEvent, ctx: ExtensionContext): boolean {
    return event.continue || hasQueuedWork(event, ctx);
  }

  function projectedAssistant(event: BoundaryEvent, entryId: string): AssistantMessage | undefined {
    return event.context.contextEntries.find((entry) => entry.sourceEntry.id === entryId)
      ?.messages.find((message): message is AssistantMessage => message.role === "assistant");
  }

  function omitTargets(entries: SessionBoundaryDraft[], event: BoundaryEvent, targetIds: string[]): SessionBoundaryDraft[] {
    // The current projection, not an old edit's existence, determines whether a
    // target is omitted. A content replacement or later restoration must not
    // prevent omission; already-omitted targets must not be edited twice.
    const active = new Set(event.context.contextEntries.filter((entry) => entry.messages.length > 0)
      .map((entry) => entry.sourceEntry.id));
    const omissions = [...new Set(targetIds)].filter((id) => active.has(id))
      .map((targetId): SessionBoundaryDraft => ({ type: "context_edit", targetId, replacement: null }));
    return [...entries, ...omissions];
  }

  function omitRecoveryArtifacts(entries: SessionBoundaryDraft[], event: BoundaryEvent): SessionBoundaryDraft[] {
    const ids = event.context.contextEntries.flatMap((entry) => {
      const source = entry.sourceEntry;
      return source.type === "custom_message" &&
        (source.customType === CHECKPOINT_TYPE || source.customType === CONTINUATION_TYPE) ? [source.id] : [];
    });
    return omitTargets(entries, event, ids);
  }

  function omitInterrupted(entries: SessionBoundaryDraft[], event: BoundaryEvent, turn: LastTurn): SessionBoundaryDraft[] {
    return omitTargets(entries, event, [turn.entryId, ...turn.toolResultIds]);
  }

  function reserve(reason: RecoveryReason, ctx: ExtensionContext): boolean {
    if (budget.canResume(reason, options)) return true;
    if (!warned) {
      warned = true;
      const exhausted = reason === "unknown-error" ? "unknown-error recovery budget exhausted" : "recovery budget exhausted";
      if (ctx.hasUI) ctx.ui.notify(`pi-continuity: ${exhausted}. Inspect the task before sending another request.`, "warning");
      if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", `continuity: ${exhausted}`);
    }
    return false;
  }

  function formatUsageWindow(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }

  /** Bounded polling for usage limits without an advertised reset time. */
  function scheduleUsagePoll(ctx: ExtensionContext): number | undefined {
    if (options.maxResumes === 0) return undefined;
    const now = Date.now();
    if (!usagePoll) {
      const windowMs = usagePollExhaustions === 0 ? USAGE_POLL_WINDOW_MS : EXTENDED_USAGE_POLL_WINDOW_MS;
      usagePoll = {
        deadline: now + windowMs, attempts: 0, maxAttempts: Math.ceil(windowMs / USAGE_POLL_DELAY_MS), windowMs, exhausted: false,
      };
    }
    const remaining = usagePoll.deadline - now;
    if (usagePoll.attempts >= usagePoll.maxAttempts || remaining <= 0) {
      if (!usagePoll.exhausted) {
        usagePoll.exhausted = true;
        usagePollExhaustions++;
        if (ctx.hasUI) ctx.ui.notify(
          `pi-continuity: usage limit has no reset time after ${formatUsageWindow(usagePoll.windowMs)}; giving up.`, "warning",
        );
      }
      return undefined;
    }
    usagePoll.attempts++;
    return Math.min(USAGE_POLL_DELAY_MS, remaining);
  }

  /** Wait only while the public abort signal is live, never at settlement. */
  async function waitAtTurnEnd(turn: LastTurn, delayMs: number, status: string, ctx: ExtensionContext): Promise<boolean> {
    const pending = { controller: new AbortController(), retryAt: Date.now() + delayMs };
    waiting = pending;
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", status);
    const signal = ctx.signal ? AbortSignal.any([pending.controller.signal, ctx.signal]) : pending.controller.signal;
    const completed = await waitForBackoff(delayMs, signal, () => last !== turn || !options.enabled || ctx.hasPendingMessages());
    if (waiting === pending) {
      waiting = undefined;
      if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", undefined);
    }
    return completed;
  }

  function resume(event: BoundaryEvent, turn: LastTurn, reason: RecoveryReason, ctx: ExtensionContext, record = true): BoundaryResult {
    const baseEntries = reason === "tool-tail" ? [...event.entries] : omitInterrupted(event.entries, event, turn);
    const entries = omitRecoveryArtifacts(baseEntries, event);
    if (record) budget.record(reason);
    turn.resumed = true;
    const attempt = record ? budget.total : usagePoll?.attempts ?? 0;
    entries.push({
      type: "custom", customType: CONTINUATION_TYPE,
      data: { requestId, reason, attempt, sourceEntryId: turn.entryId, originalStopReason: turn.message.stopReason },
    });
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-continuity", record ? `continuity: ${reason} #${budget.total}` : `continuity: usage-limit poll #${attempt}`);
    return { entries, continue: true };
  }

  pi.on("session_start", (_event, ctx) => {
    reset(ctx);
    usagePollExhaustions = 0;
    configurationValid = false;
    try {
      options = {
        enabled: parseBoolean(pi.getFlag("continuity"), "continuity", true),
        toolTail: parseBoolean(pi.getFlag("continuity-tool-tail"), "continuity-tool-tail", true),
        maxResumes: parseCount(pi.getFlag("continuity-max-resumes"), "continuity-max-resumes", 16, true),
        streamRetries: parseCount(pi.getFlag("continuity-stream-retries"), "continuity-stream-retries", DEFAULT_STREAM_RETRIES),
        unknownRetries: parseCount(pi.getFlag("continuity-unknown-retries"), "continuity-unknown-retries", DEFAULT_UNKNOWN_RETRIES),
        streamDelayMs: parseCount(pi.getFlag("continuity-stream-delay-ms"), "continuity-stream-delay-ms", DEFAULT_STREAM_DELAY_MS),
        checkpointMaxChars: parseCheckpointMaxChars(),
      };
      configurationValid = true;
    } catch (error) {
      options.enabled = false;
      throw error;
    }
  });
  pi.on("before_agent_start", (_event, ctx) => reset(ctx));
  pi.on("input", () => {
    // Input hooks precede asynchronous enqueue. Preserve that interruption so
    // an error turn can leave its assistant tail for Pi's follow-up selector.
    if (waiting && last) last.inputInterrupted = true;
    waiting?.controller.abort();
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") {
      const queuedDuringRun = !ctx.isIdle() && last !== undefined;
      reset(ctx, !queuedDuringRun, queuedDuringRun);
    }
  });
  pi.on("context", (event) => ({ messages: event.messages.filter((message) => {
    // Legacy prompt artifacts are always excluded, even when recovery is off,
    // max-resumes is zero, or configuration failed closed. Raw history is intact.
    if (message.role === "custom" && (message.customType === CHECKPOINT_TYPE || message.customType === CONTINUATION_TYPE)) return false;
    if (!options.enabled || options.maxResumes === 0) return true;
    return message.role !== "assistant" ||
      (message.stopReason !== "error" && message.stopReason !== "length" && message.stopReason !== "aborted");
  }) }));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("agent_settled", () => { last = undefined; waiting?.controller.abort(); waiting = undefined; });

  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const projected = projectedAssistant(event, event.messageEntryId);
    last = {
      message: projected ?? { ...event.message, content: [] }, entryId: event.messageEntryId,
      toolResultIds: event.toolResultEntryIds, resumed: false,
    };
    const reason = recoveryReason(last.message);
    if (event.outcome === "aborted" || ctx.signal?.aborted) return;
    if (!reason || !eligible(reason)) {
      const entries = omitRecoveryArtifacts(event.entries, event);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    if (reason === "truncation" && last.message.stopReason === "length") {
      if (hasOtherWork(event, ctx) || (last.toolResultIds.length > 0 && !budget.canResume(reason, options))) {
        // Pi can continue truncated tools even after our cap; omit their
        // assistant and synthetic results together without another continuation.
        return { entries: omitRecoveryArtifacts(omitInterrupted(event.entries, event, last), event) };
      }
      if (reserve(reason, ctx)) return resume(event, last, reason, ctx);
      return;
    }
    const turn = last;
    if (usesStreamBudget(reason) && !hasQueuedWork(event, ctx) &&
      (turn.message.stopReason === "error" || !event.continue) && reserve(reason, ctx)) {
      const delayMs = streamDelay(options.streamDelayMs, budget.streams + 1);
      turn.fallbackWaitCompleted = await waitAtTurnEnd(turn, delayMs, `continuity: ${reason}; retry in ${formatDelayMs(delayMs)}`, ctx);
      if (last !== turn || ctx.signal?.aborted || !options.enabled) return;
    }
    if (turn.message.stopReason === "error") {
      // Core hard-exits errors even if turn_end asked to continue. Native retry
      // gets first refusal after these waits, and may add its own backoff.
      if (reason === "usage-limit" && !hasQueuedWork(event, ctx)) {
        const delayMs = retryDelayMs(turn.message.errorMessage ?? "");
        if (delayMs !== undefined) {
          if (reserve(reason, ctx)) {
            if (ctx.hasUI) ctx.ui.notify(`pi-continuity: provider cooldown; waiting ${formatDelayMs(delayMs)} before continuing.`, "warning");
            turn.usageWaitCompleted = await waitAtTurnEnd(turn, delayMs, `continuity: provider cooldown; retry in ${formatDelayMs(delayMs)}`, ctx);
            if (last !== turn || ctx.signal?.aborted || !options.enabled) return;
          }
        } else {
          const pollDelayMs = scheduleUsagePoll(ctx);
          if (pollDelayMs !== undefined) {
            const attempt = usagePoll?.attempts ?? 0;
            turn.usagePoll = true;
            if (attempt === 1 && ctx.hasUI) ctx.ui.notify(
              `pi-continuity: usage limit has no reset time; polling every ${USAGE_POLL_DELAY_MS / 60_000} min ` +
                `for up to ${formatUsageWindow(usagePoll?.windowMs ?? USAGE_POLL_WINDOW_MS)}.`, "warning",
            );
            turn.usageWaitCompleted = await waitAtTurnEnd(turn, pollDelayMs,
              `continuity: usage limit; poll ${attempt}/${usagePoll?.maxAttempts ?? 0} in ${formatDelayMs(pollDelayMs)}`, ctx);
            if (last !== turn || ctx.signal?.aborted || !options.enabled) return;
          }
        }
      }
      // Keeping the error assistant as the tail lets Agent.continue() drain
      // queued follow-up input before another old-task request. The context hook
      // still excludes its broken protocol. No partial text is ever replayed.
      const baseEntries = turn.inputInterrupted || hasQueuedWork(event, ctx) ? event.entries : omitInterrupted(event.entries, event, turn);
      const entries = omitRecoveryArtifacts(baseEntries, event);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
  });

  pi.on("agent_before_settle", (event, ctx) => {
    const turn = last;
    if (!turn || turn.resumed || event.outcome === "aborted" || ctx.signal?.aborted || hasOtherWork(event, ctx)) return;
    const reason = recoveryReason(turn.message);
    if (!reason || !eligible(reason) || (reason === "usage-limit" && !turn.usageWaitCompleted) ||
      (usesStreamBudget(reason) && !turn.fallbackWaitCompleted)) return;
    const polled = reason === "usage-limit" && turn.usagePoll === true;
    if (reason === "tool-tail") {
      const projected = projectedAssistant(event, turn.entryId);
      if (!projected || recoveryReason(projected) !== "tool-tail" || event.context.llmMessages.at(-1)?.role === "user") return;
    }
    if (!polled && !reserve(reason, ctx)) return;
    return resume(event, turn, reason, ctx, !polled);
  });

  pi.registerCommand("pi-continuity", {
    description: "Inspect or toggle recovery: /pi-continuity [status|on|off]",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") {
        if (action === "on" && !configurationValid) {
          ctx.ui.notify("pi-continuity: cannot enable recovery with invalid flags. Fix the configuration and reload.", "warning");
          return;
        }
        options.enabled = action === "on";
        if (!options.enabled) waiting?.controller.abort();
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /pi-continuity [status|on|off]", "warning");
        return;
      }
      const remainingMs = waiting ? Math.max(0, waiting.retryAt - Date.now()) : 0;
      if (ctx.hasUI) ctx.ui.notify([
        `pi-continuity: ${options.enabled ? "on" : "off"}; tool-tail ${options.toolTail ? "on" : "off"}`,
        `Last/current user request: ${budget.total}/${options.maxResumes === Infinity ? "unlimited" : options.maxResumes} extra continuations; ${budget.streams}/${options.streamRetries} shared stream/empty/unknown recoveries.`,
        `Truncation ${budget.counts.truncation}; stream errors ${budget.counts["stream-error"]}; unknown errors ${budget.counts["unknown-error"]}/${options.unknownRetries}; usage limits/cooldowns ${budget.counts["usage-limit"]}; empty responses ${budget.counts["empty-response"]}; tool tails ${budget.counts["tool-tail"]}.`,
        ...(waiting ? [`Next recovery in ${formatDelayMs(remainingMs)}.`] : []),
        ...(usagePoll ? [`Usage-limit polling: ${usagePoll.attempts}/${usagePoll.maxAttempts}; ${usagePoll.exhausted ? "gave up" : `gives up in ${Math.max(0, Math.ceil((usagePoll.deadline - Date.now()) / 60_000))} min`}.`] : []),
      ].join("\n"), "info");
    },
  });
}
