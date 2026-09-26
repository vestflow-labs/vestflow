/**
 * Off-main-thread claimable recalculation for the portfolio timeline.
 *
 * Dragging the time cursor re-projects every schedule in the portfolio. At 200+
 * schedules that work would eat the frame budget on the main thread and the
 * drag would visibly stutter, so it happens here instead: the main thread posts
 * a cursor ledger and gets back one claimable amount per schedule.
 *
 * The schedule set is sent once and cached — subsequent cursor updates carry
 * only a number, which keeps per-frame structured-clone cost near zero.
 *
 * No network access: all the math is the pure module shared with the main
 * thread, so a worker result and a fallback main-thread result are identical.
 */

import {
  computeClaimableForCursor,
  type ClaimableRequest,
  type ClaimableResponse,
} from "../lib/portfolio/claimable";
import type { TimelineSchedule } from "../lib/portfolio/types";

/**
 * Minimal view of the worker global.
 *
 * The project's `tsconfig` loads the DOM lib, where `self` is a `Window` whose
 * `postMessage` demands a target origin. Narrowing to what a dedicated worker
 * actually provides avoids pulling in the conflicting `webworker` lib.
 */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<ClaimableRequest>) => void) | null;
  postMessage(message: ClaimableResponse): void;
}

const ctx = self as unknown as WorkerScope;

let cachedSchedules: TimelineSchedule[] = [];

ctx.onmessage = (event: MessageEvent<ClaimableRequest>) => {
  const request = event.data;
  if (!request || typeof request.cursorLedger !== "number") return;

  if (Array.isArray(request.schedules)) {
    cachedSchedules = request.schedules;
  }

  ctx.postMessage({
    cursorLedger: request.cursorLedger,
    requestId: request.requestId,
    results: computeClaimableForCursor(cachedSchedules, request.cursorLedger),
  });
};
