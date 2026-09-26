"use client";

import { useState, useRef, useEffect } from "react";

interface CopyLinkButtonProps {
  url?: string;
  label?: string;
  className?: string;
  variant?: "button" | "icon" | "pill";
}

export default function CopyLinkButton({
  url,
  label = "Copy Link",
  className = "",
  variant = "button",
}: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const [showFallbackModal, setShowFallbackModal] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState(url || "");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setResolvedUrl(url || window.location.href);
    }
  }, [url]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    const targetUrl = resolvedUrl || (typeof window !== "undefined" ? window.location.href : "");
    if (!targetUrl) return;

    let success = false;

    // 1. Try Clipboard API
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(targetUrl);
        success = true;
      } catch (err) {
        // Fall through to execCommand
        success = false;
      }
    }

    // 2. Fallback to execCommand if clipboard API failed or is not supported
    if (!success && typeof document !== "undefined") {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = targetUrl;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        success = document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch (e) {
        success = false;
      }
    }

    // 3. If copy succeeded, show "Copied!" tooltip for 2 seconds
    if (success) {
      setCopied(true);
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 2000); // 2 seconds tooltip as required by acceptance criteria
    } else {
      // 4. Fallback modal for browsers without clipboard access
      setShowFallbackModal(true);
    }
  };

  const getButtonContent = () => {
    if (copied) {
      return (
        <>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 text-emerald-400 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-emerald-300 font-medium">Copied!</span>
        </>
      );
    }

    return (
      <>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
        <span>{label}</span>
      </>
    );
  };

  return (
    <>
      <div className="relative inline-flex items-center">
        <button
          type="button"
          onClick={handleCopy}
          aria-label={label}
          title={copied ? "Copied!" : label}
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 min-h-[44px] rounded-lg border transition-all ${
            copied
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-sm shadow-emerald-500/20"
              : "border-white/10 bg-white/5 text-zinc-300 hover:border-white/20 hover:text-white hover:bg-white/10"
          } ${className}`}
        >
          {getButtonContent()}
        </button>

        {/* 2-second Copied Tooltip bubble */}
        {copied && (
          <div
            role="status"
            aria-live="polite"
            className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-zinc-900 border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold rounded shadow-lg pointer-events-none whitespace-nowrap z-30 animate-fade-in"
          >
            Copied to clipboard!
          </div>
        )}
      </div>

      {/* Fallback Modal for browsers without clipboard API */}
      {showFallbackModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="copy-link-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
        >
          <div className="bg-zinc-900 border border-white/15 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="copy-link-modal-title" className="text-base font-semibold text-white">
                Share Link
              </h3>
              <button
                type="button"
                onClick={() => setShowFallbackModal(false)}
                className="text-zinc-400 hover:text-white transition-colors p-1 min-h-[44px] min-w-[44px] flex items-center justify-center"
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-zinc-400">
              Your browser does not support automatic clipboard copying. Please copy the link below manually:
            </p>

            <div className="relative">
              <input
                type="text"
                readOnly
                value={resolvedUrl}
                onFocus={(e) => e.target.select()}
                className="w-full text-xs font-mono bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-zinc-200 select-all focus:outline-none focus:border-violet-500"
              />
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowFallbackModal(false)}
                className="btn-primary rounded-lg px-4 py-1.5 min-h-[44px] text-xs font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
