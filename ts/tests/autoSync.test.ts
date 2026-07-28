import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAutoSyncIntervalMs,
  runAutoSyncLoop,
} from "../src/startupSync.ts";

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("auto-sync interval defaults, disables, and rejects unsafe values", () => {
  assert.equal(resolveAutoSyncIntervalMs(undefined), 3_600_000);
  assert.equal(resolveAutoSyncIntervalMs("0"), 0);
  assert.equal(resolveAutoSyncIntervalMs("60"), 60_000);
  assert.equal(resolveAutoSyncIntervalMs("604800"), 604_800_000);
  for (const value of ["", "   ", "59", "-1", "604801", "invalid", "1.5", "1e3"]) {
    assert.equal(resolveAutoSyncIntervalMs(value), 3_600_000);
  }
});

test("auto-sync waits for a cycle before scheduling the next one", async () => {
  const forceChecks: boolean[] = [];
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  let finishFirst: (() => void) | undefined;
  let unrefCalls = 0;

  runAutoSyncLoop(
    (forceCheck) => {
      forceChecks.push(forceCheck);
      if (forceChecks.length === 1) {
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve();
    },
    60_000,
    (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return { unref: () => { unrefCalls += 1; } };
    },
  );

  assert.deepEqual(forceChecks, [false]);
  assert.deepEqual(callbacks, []);

  finishFirst?.();
  await flushPromises();
  assert.deepEqual(delays, [60_000]);
  assert.equal(unrefCalls, 1);

  callbacks.shift()?.();
  await flushPromises();
  assert.deepEqual(forceChecks, [false, true]);
  assert.deepEqual(delays, [60_000, 60_000]);
});

test("disabled periodic sync still runs the startup cycle", async () => {
  const forceChecks: boolean[] = [];
  let schedules = 0;

  runAutoSyncLoop(
    async (forceCheck) => { forceChecks.push(forceCheck); },
    0,
    () => {
      schedules += 1;
      return {};
    },
  );

  await flushPromises();
  assert.deepEqual(forceChecks, [false]);
  assert.equal(schedules, 0);
});

test("auto-sync schedules another cycle after an unexpected error", async () => {
  const callbacks: Array<() => void> = [];
  const forceChecks: boolean[] = [];

  runAutoSyncLoop(
    async (forceCheck) => {
      forceChecks.push(forceCheck);
      if (!forceCheck) throw new Error("boom");
    },
    60_000,
    (callback) => {
      callbacks.push(callback);
      return {};
    },
  );

  await flushPromises();
  assert.equal(callbacks.length, 1);
  callbacks.shift()?.();
  await flushPromises();
  assert.deepEqual(forceChecks, [false, true]);
});
