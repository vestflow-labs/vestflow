"use client";

import { ChangeEvent } from "react";

interface SearchFilterBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  resultCount?: number;
  totalCount?: number;
  id?: string;
}

export default function SearchFilterBar({
  value,
  onChange,
  placeholder = "Filter by address prefix or token symbol...",
  className = "",
  resultCount,
  totalCount,
  id = "stream-search-filter",
}: SearchFilterBarProps) {
  const handleClear = () => {
    onChange("");
  };

  return (
    <div className={`relative flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full ${className}`}>
      <div className="relative flex-1">
        <label htmlFor={id} className="sr-only">
          Search and filter streams
        </label>
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <input
          id={id}
          type="text"
          role="searchbox"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-10 pr-10 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 transition-colors"
          aria-label="Filter streams"
          autoComplete="off"
          spellCheck="false"
        />
        {value && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-zinc-400 hover:text-white transition-colors"
            aria-label="Clear filter"
            title="Clear filter"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {typeof resultCount === "number" && typeof totalCount === "number" && value.trim() && (
        <div className="text-xs text-zinc-400 whitespace-nowrap self-center sm:self-auto px-1">
          Showing <span className="font-medium text-zinc-200">{resultCount}</span> of{" "}
          <span className="font-medium text-zinc-200">{totalCount}</span>
        </div>
      )}
    </div>
  );
}
