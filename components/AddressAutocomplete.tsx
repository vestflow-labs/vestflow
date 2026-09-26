"use client";

import { useEffect, useRef, useState } from "react";
import { useAddressBook } from "@/hooks/useAddressBook";

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoComplete?: string;
}

/**
 * Input field with autocomplete suggestions from the address book.
 * Shows matching addresses and nicknames as user types.
 */
export function AddressAutocomplete({
  value,
  onChange,
  placeholder = "G...",
  className = "",
  autoComplete,
}: AddressAutocompleteProps) {
  const { addressBook } = useAddressBook();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<Array<{ address: string; label: string }>>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter suggestions based on input
  useEffect(() => {
    const query = value.trim().toLowerCase();

    if (!query) {
      setFilteredSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const suggestions = Object.entries(addressBook)
      .map(([address, label]) => ({ address, label }))
      .filter(
        ({ address, label }) =>
          address.toLowerCase().includes(query) ||
          label.toLowerCase().includes(query)
      )
      .sort(({ label: a }, { label: b }) => a.localeCompare(b))
      .slice(0, 5);

    setFilteredSuggestions(suggestions);
    setShowSuggestions(suggestions.length > 0);
    setHighlightedIndex(-1);
  }, [value, addressBook]);

  // Close suggestions when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < filteredSuggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIndex >= 0) {
          selectSuggestion(filteredSuggestions[highlightedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        setShowSuggestions(false);
        break;
    }
  };

  const selectSuggestion = ({ address, label }: { address: string; label: string }) => {
    onChange(address);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (value.trim() && filteredSuggestions.length > 0) {
            setShowSuggestions(true);
          }
        }}
        placeholder={placeholder}
        autoComplete={autoComplete || "off"}
        className={`input ${className}`}
        style={{
          background: "var(--input-bg)",
          color: "var(--foreground)",
          borderColor: "var(--input-border)",
        }}
      />

      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg shadow-lg z-10 overflow-hidden"
             style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)" }}>
          <ul className="divide-y divide-white/10">
            {filteredSuggestions.map(({ address, label }, index) => (
              <li key={address}>
                <button
                  type="button"
                  onClick={() => selectSuggestion({ address, label })}
                  className="w-full text-left px-4 py-2 text-sm transition-colors"
                  style={{
                    background: highlightedIndex === index ? "var(--overlay-medium)" : "transparent",
                    color: highlightedIndex === index ? "var(--accent-primary)" : "var(--foreground)",
                  }}
                >
                  <div className="font-medium">{label}</div>
                  <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>
                    {address}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
