/**
 * Pure toast-queue state machine for the real-time notification toasts.
 *
 * Kept free of React so the acceptance criteria ("5 simultaneous events → 3
 * toasts visible, 2 queued") can be asserted directly in unit tests.
 */

export interface NotificationToast {
  /** Notification id — also the dedupe key. */
  id: number;
  event_type: string;
  title: string;
}

export interface ToastQueueState {
  visible: NotificationToast[];
  queued: NotificationToast[];
}

export const MAX_VISIBLE_TOASTS = 3;

export const emptyQueue: ToastQueueState = { visible: [], queued: [] };

/**
 * Adds a toast to the visible set when there is room, otherwise enqueues it.
 * Duplicate ids are ignored (a notification may be delivered more than once).
 */
export function pushToast(
  state: ToastQueueState,
  toast: NotificationToast,
): ToastQueueState {
  if (state.visible.some((t) => t.id === toast.id)) return state;
  if (state.queued.some((t) => t.id === toast.id)) return state;

  if (state.visible.length < MAX_VISIBLE_TOASTS) {
    return { visible: [...state.visible, toast], queued: state.queued };
  }
  return { visible: state.visible, queued: [...state.queued, toast] };
}

/**
 * Removes a toast by id, promoting the oldest queued toast into the freed slot.
 */
export function dismissToast(
  state: ToastQueueState,
  id: number,
): ToastQueueState {
  const visible = state.visible.filter((t) => t.id !== id);
  if (visible.length === state.visible.length) return state;

  if (state.queued.length > 0 && visible.length < MAX_VISIBLE_TOASTS) {
    const [next, ...rest] = state.queued;
    return { visible: [...visible, next], queued: rest };
  }
  return { visible, queued: state.queued };
}
