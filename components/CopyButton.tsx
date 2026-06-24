"use client";

import { useEffect, useRef, useState } from "react";

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

interface CopyButtonProps {
  value: string;
  label: string;
  className?: string;
}

export default function CopyButton({ value, label, className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await copyText(value);
      setCopied(true);

      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }

      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error("Failed to copy to clipboard", error);
    }
  };

  const baseClasses =
    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors";
  const stateClasses = copied
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:text-white";

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={copied ? "Copied" : label}
      className={`${baseClasses} ${stateClasses} ${className}`}
    >
      {copied ? (
        <>
          <CheckIcon />
          <span>Copied</span>
        </>
      ) : (
        <>
          <CopyIcon />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
