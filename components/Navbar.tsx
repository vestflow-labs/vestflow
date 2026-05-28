"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import WalletButton from "./WalletButton";
import { NETWORK } from "@/lib/stellar";

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
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 border-b border-white/5 bg-[#08090f]/80 dark:bg-[#08090f]/80 backdrop-blur-md">
      <Link href="/" className="flex items-center gap-2 font-bold text-lg">
        <span className="text-xl">🔒</span>
        <span className="gradient-text">VestFlow</span>
      </Link>
      <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
        <Link href="/app" className="hover:text-white transition-colors">Dashboard</Link>
        <Link href="/app/create" className="hover:text-white transition-colors">New Schedule</Link>
        <a href="https://github.com/libby-coder/vestflow" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
        <a href="https://github.com/libby-coder/vestflow/issues" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Contribute</a>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${NETWORK === "mainnet" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"}`}>
          {NETWORK === "mainnet" ? "Mainnet" : "Testnet"}
        </span>
        <button
          onClick={toggleTheme}
          aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          className="text-zinc-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/5"
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>
        <WalletButton />
      </div>
    </nav>
  );
}