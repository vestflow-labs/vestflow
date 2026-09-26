"use client";

import { useEffect, useState } from "react";

type ThemeMode = "light" | "dark" | "system";

/**
 * Hook to manage theme switching and persistence.
 * Syncs with localStorage and applies class to <html> element.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>("system");
  const [isDark, setIsDark] = useState(false);

  // Initialize theme from localStorage
  useEffect(() => {
    try {
      const stored = (localStorage.getItem("vestflow-theme") as ThemeMode) || "system";
      setThemeState(stored);

      // Determine if currently dark
      const isCurrentlyDark =
        stored === "dark" || (stored === "system" && window.matchMedia("(prefers-color-scheme:dark)").matches);
      setIsDark(isCurrentlyDark);
    } catch {
      setTheme("system");
    }
  }, []);

  // Watch for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme:dark)");

    const handleChange = () => {
      if (theme === "system") {
        setIsDark(mediaQuery.matches);
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const setTheme = (newTheme: ThemeMode) => {
    setThemeState(newTheme);
    localStorage.setItem("vestflow-theme", newTheme);

    // Update <html> class
    const isDarkMode =
      newTheme === "dark" || (newTheme === "system" && window.matchMedia("(prefers-color-scheme:dark)").matches);
    if (isDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    setIsDark(isDarkMode);
  };

  return { theme, isDark, setTheme };
}
