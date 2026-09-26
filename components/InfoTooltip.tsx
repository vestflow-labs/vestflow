"use client";
import { useState } from "react";

export default function InfoTooltip({ text }: { text: string }) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setIsVisible(!isVisible)}
        onBlur={() => setIsVisible(false)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-xs font-semibold text-zinc-600 hover:text-zinc-400 hover:bg-white/5 transition-colors cursor-help"
        aria-label="More information"
      >
        ?
      </button>
      {isVisible && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-300 leading-relaxed z-10 shadow-lg">
          {text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-zinc-800" />
        </div>
      )}
    </div>
  );
}
