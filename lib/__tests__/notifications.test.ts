import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
} from "../notifications";
import {
  dismissToast,
  emptyQueue,
  MAX_VISIBLE_TOASTS,
  pushToast,
  type NotificationToast,
} from "../toast-queue";

function toast(id: number): NotificationToast {
  return { id, event_type: "Claimed", title: `Claimed ${id}` };
}

describe("backoffDelayMs", () => {
  it("doubles from 1s and caps at 30s", () => {
    expect(backoffDelayMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(16000);
    expect(backoffDelayMs(5)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(100)).toBe(BACKOFF_MAX_MS);
  });

  it("treats negative attempts as the first attempt", () => {
    expect(backoffDelayMs(-3)).toBe(BACKOFF_BASE_MS);
  });
});

describe("toast queue", () => {
  it("shows at most 3 toasts and queues the rest", () => {
    let state = emptyQueue;
    for (let i = 1; i <= 5; i++) {
      state = pushToast(state, toast(i));
    }

    expect(state.visible).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(state.visible.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(state.queued.map((t) => t.id)).toEqual([4, 5]);
  });

  it("promotes the oldest queued toast when one is dismissed", () => {
    let state = emptyQueue;
    for (let i = 1; i <= 5; i++) {
      state = pushToast(state, toast(i));
    }

    state = dismissToast(state, 1);
    expect(state.visible.map((t) => t.id)).toEqual([2, 3, 4]);
    expect(state.queued.map((t) => t.id)).toEqual([5]);
  });

  it("ignores duplicate ids", () => {
    let state = pushToast(emptyQueue, toast(1));
    state = pushToast(state, toast(1));
    expect(state.visible).toHaveLength(1);
  });

  it("dismissing an unknown id is a no-op", () => {
    const state = pushToast(emptyQueue, toast(1));
    expect(dismissToast(state, 999)).toBe(state);
  });
});
