"use client";
import { NETWORK } from "@/lib/stellar";
import Link from "next/link";
import { useEffect, useState } from "react";
import WalletButton from "./WalletButton";

function SunIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export default function Navbar() {
  // Start with true (dark) to match the default applied by the inline
  // theme-init script in layout.tsx — avoids a visual toggle on mount.
  const [isDark, setIsDark] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("vestflow-theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("vestflow-theme", "light");
    }
  };

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/5 bg-[#08090f]/80 dark:bg-[#08090f]/80 backdrop-blur-md">
      <Link href="/" className="flex items-center gap-2 font-bold text-lg">
        <span className="text-xl">🔒</span>
        <span className="gradient-text">VestFlow</span>
      </Link>

      {/* Desktop nav links */}
      <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
        <Link href="/app" className="hover:text-white transition-colors">Dashboard</Link>
        <Link href="/app/beneficiary" className="hover:text-white transition-colors">Beneficiary</Link>
        <Link href="/app/create" className="hover:text-white transition-colors">New Schedule</Link>
        <Link href="/analytics" className="hover:text-white transition-colors">Analytics</Link>
        <Link href="/widget" className="hover:text-white transition-colors">Widget</Link>
        <Link href="/learn" className="hover:text-white transition-colors">Learn</Link>
        <Link href="/faq" className="hover:text-white transition-colors">FAQ</Link>
        <a href="https://github.com/libby-coder/vestflow" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <span className={`hidden sm:inline text-xs px-2 py-0.5 rounded-full font-medium ${NETWORK === "mainnet" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"}`}>
          {NETWORK === "mainnet" ? "Mainnet" : "Testnet"}
        </span>
        <button
          onClick={toggleTheme}
          aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          className="text-zinc-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/5"
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>

        {/* Hamburger button (mobile) */}
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="md:hidden text-zinc-400 hover:text-white transition-colors p-1.5"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
        >
          {menuOpen ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          )}
        </button>

        <WalletButton />

        {/* Network badge inline on mobile */}
        <span className={`md:hidden text-[10px] px-1.5 py-0.5 rounded-full font-medium ${NETWORK === "mainnet" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"}`}>
          {NETWORK === "mainnet" ? "M" : "T"}
        </span>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="absolute top-full left-0 right-0 flex flex-col gap-2 px-4 py-4 border-b border-white/5 bg-[#08090f]/95 backdrop-blur-md md:hidden">
          <Link href="/app" onClick={() => setMenuOpen(false)} className="text-sm text-zinc-400 hover:text-white transition-colors py-2">Dashboard</Link>
          <Link href="/app/beneficiary" onClick={() => setMenuOpen(false)} className="text-sm text-zinc-400 hover:text-white transition-colors py-2">Beneficiary</Link>
          <Link href="/app/create" onClick={() => setMenuOpen(false)} className="text-sm text-zinc-400 hover:text-white transition-colors py-2">New Schedule</Link>
          <Link href="/analytics" onClick={() => setMenuOpen(false)} className="text-sm text-zinc-400 hover:text-white transition-colors py-2">Analytics</Link>
          <Link href="/widget" onClick={() => setMenuOpen(false)} className="text-sm text-zinc-400 hover:text-white transition-colors py-2">Widget</Link>
          <Link href="/learn" onClick={() => setMenuOpen(false)} className="text-sm text-zinc-400 hover:text-white transition-colors py-2">Learn</Link>
          <Link href="/faq" onClick={() => setMenuOpen(false)} className="text-sm text-zinc-400 hover:text-white transition-colors py-2">FAQ</Link>
          <a href="https://github.com/libby-coder/vestflow" onClick={() => setMenuOpen(false)} target="_blank" rel="noopener noreferrer" className="text-sm text-zinc-400 hover:text-white transition-colors py-2">GitHub</a>
        </div>
      )}
    </nav>
  );
}