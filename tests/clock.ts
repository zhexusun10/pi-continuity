import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import { setImmediate } from "node:timers/promises";

/** Virtual wall clock without experimental MockTimers or real minute/hour waits. */
export function fakeClock(t: TestContext) {
  let now = 1_800_000_000_000;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  const delays: number[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timer = nodeSetTimeout(() => {}, 0);
    nodeClearTimeout(timer);
    timers.set(timer, { at: now + delay, run: () => callback(...args) });
    delays.push(delay);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout> | string | number | undefined) => {
    if (typeof timer === "object") timers.delete(timer);
    nodeClearTimeout(timer);
  });
  return {
    delays,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.at <= now);
        if (!due) return;
        timers.delete(due[0]);
        due[1].run();
      }
    },
  };
}

export async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.ok(predicate(), "expected asynchronous boundary state was not reached");
}
