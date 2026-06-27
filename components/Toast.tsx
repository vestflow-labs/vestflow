"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToastStatus = "pending" | "success" | "error";

export interface Toast {
  id: string;
  status: ToastStatus;
  title: string;
  message?: string;
  txHash?: string;
  network?: string;
  duration?: number; // ms before auto-dismiss (0 = never)
  retryLabel?: string;
  onRetry?: () => void;
}

interface ToastCtx {
  addToast: (toast: Omit<Toast, "id">) => string;
  updateToast: (id: string, patch: Partial<Omit<Toast, "id">>) => void;
  removeToast: (id: string) => void;
}

// ─── Context ─────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastCtx>({
  addToast: () => "",
  updateToast: () => {},
  removeToast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

// ─── Individual Toast Item ────────────────────────────────────────────────────

function ToastItem({
  toast,
  onRemove,
}: {
  toast: Toast;
  onRemove: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Slide-in on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Auto-dismiss for success / error toasts
  useEffect(() => {
    const dur =
      toast.duration ??
      (toast.status === "pending" || toast.status === "error" ? 0 : 5000);
    if (dur === 0) return;
    timerRef.current = setTimeout(() => dismiss(), dur);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.status, toast.duration]);

  const dismiss = () => {
    setVisible(false);
    setTimeout(() => onRemove(toast.id), 300);
  };

  const icons: Record<ToastStatus, string> = {
    pending: "⏳",
    success: "✅",
    error: "❌",
  };

  const borderColors: Record<ToastStatus, string> = {
    pending: "border-yellow-500/40",
    success: "border-green-500/40",
    error: "border-red-500/40",
  };

  const bgColors: Record<ToastStatus, string> = {
    pending: "bg-yellow-500/5",
    success: "bg-green-500/5",
    error: "bg-red-500/5",
  };

  const textColors: Record<ToastStatus, string> = {
    pending: "text-yellow-300",
    success: "text-green-300",
    error: "text-red-300",
  };

  const network = toast.network ?? "testnet";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`
        relative flex items-start gap-3 rounded-xl border px-4 py-3 shadow-xl backdrop-blur-md
        transition-all duration-300 ease-out max-w-sm w-full
        ${borderColors[toast.status]} ${bgColors[toast.status]}
        ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}
      `}
    >
      {/* Status icon / spinner */}
      <div className="mt-0.5 shrink-0 text-base leading-none">
        {toast.status === "pending" ? (
          <svg
            className="animate-spin h-4 w-4 text-yellow-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
        ) : (
          <span aria-hidden="true">{icons[toast.status]}</span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-semibold leading-snug ${textColors[toast.status]}`}
        >
          {toast.title}
        </p>
        {toast.message && (
          <p className="text-xs text-zinc-400 mt-0.5">{toast.message}</p>
        )}
        {toast.txHash && toast.status === "success" && (
          <a
            href={`https://stellar.expert/explorer/${network}/tx/${toast.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-violet-400 hover:text-violet-300 font-mono mt-1 block truncate transition-colors"
          >
            {toast.txHash.slice(0, 12)}…{toast.txHash.slice(-8)} ↗
          </a>
        )}
        {toast.status === "error" && toast.onRetry && (
          <button
            onClick={toast.onRetry}
            className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-violet-300 hover:bg-white/10 transition-colors"
            type="button"
          >
            {toast.retryLabel ?? "Retry"}
          </button>
        )}
      </div>

      {/* Close button */}
      {toast.status !== "pending" && (
        <button
          onClick={dismiss}
          aria-label="Dismiss notification"
          className="shrink-0 text-zinc-500 hover:text-white transition-colors leading-none mt-0.5"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── Provider + Portal ────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  const addToast = useCallback((toast: Omit<Toast, "id">): string => {
    let insertedId = "";
    setToasts((prev) => {
      if (toast.txHash) {
        const existing = prev.find((t) => t.txHash === toast.txHash);
        if (existing) {
          insertedId = existing.id;
          return prev.map((t) =>
            t.id === existing.id ? { ...t, ...toast } : t,
          );
        }
      }

      const id = `toast-${++counterRef.current}`;
      insertedId = id;
      return [...prev, { ...toast, id }];
    });
    return insertedId;
  }, []);

  const updateToast = useCallback(
    (id: string, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
    },
    [],
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, updateToast, removeToast }}>
      {children}
      {/* Fixed portal — bottom-right on desktop, bottom-center on mobile */}
      <div
        aria-label="Notifications"
        className="fixed bottom-5 right-5 left-5 sm:left-auto z-[9999] flex flex-col gap-2 items-end pointer-events-none"
      >
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto w-full sm:w-auto">
            <ToastItem toast={t} onRemove={removeToast} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
