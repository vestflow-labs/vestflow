/**
 * Persistence for unsent Give modal drafts (#808).
 * All storage access is guarded so private mode / disabled storage never
 * breaks the modal.
 */

export const GIVE_DRAFT_STORAGE_KEY = "vestflow:give-draft";

export interface GiveDraft {
  receiver: string;
  token: string;
  amount: string;
  savedAt: number;
}

export function isDraftEmpty(draft: Pick<GiveDraft, "receiver" | "amount">): boolean {
  return !draft.receiver.trim() && !draft.amount.trim();
}

export function loadGiveDraft(): GiveDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GIVE_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GiveDraft>;
    const draft: GiveDraft = {
      receiver: typeof parsed.receiver === "string" ? parsed.receiver : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
      amount: typeof parsed.amount === "string" ? parsed.amount : "",
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
    };
    return isDraftEmpty(draft) ? null : draft;
  } catch {
    return null;
  }
}

export function saveGiveDraft(draft: Omit<GiveDraft, "savedAt">): void {
  if (typeof window === "undefined") return;
  if (isDraftEmpty(draft)) {
    clearGiveDraft();
    return;
  }
  try {
    window.localStorage.setItem(
      GIVE_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...draft, savedAt: Date.now() }),
    );
  } catch {
    // storage full or unavailable — drafts are best effort
  }
}

export function clearGiveDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GIVE_DRAFT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
