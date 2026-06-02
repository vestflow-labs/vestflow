/**
 * Utility to read CSS variables (theme tokens) from the DOM.
 * Used in components that need dynamic color values (e.g., SVG, charts).
 */
export function getCSSVariable(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Get all theme color tokens as an object
 */
export function getThemeColors() {
  return {
    // Accents
    accentPrimary: getCSSVariable("--accent-primary"),
    accentSecondary: getCSSVariable("--accent-secondary"),
    accentSuccess: getCSSVariable("--accent-success"),
    accentWarning: getCSSVariable("--accent-warning"),
    accentError: getCSSVariable("--accent-error"),
    
    // Neutral
    neutral300: getCSSVariable("--neutral-300"),
    neutral400: getCSSVariable("--neutral-400"),
    neutral500: getCSSVariable("--neutral-500"),
    neutral600: getCSSVariable("--neutral-600"),
    
    // Component
    mutedLight: getCSSVariable("--muted-light"),
    mutedLighter: getCSSVariable("--muted-lighter"),
    
    // Backgrounds/Borders
    borderSubtle: getCSSVariable("--border-subtle"),
    borderDefault: getCSSVariable("--border-default"),
    overlayLight: getCSSVariable("--overlay-light"),
    overlayMedium: getCSSVariable("--overlay-medium"),
  };
}

/**
 * Hook-friendly wrapper to get colors with reactivity
 * Useful in client components that render SVG or need dynamic color updates
 */
export function useThemeColors() {
  if (typeof window === "undefined") {
    return getThemeColors();
  }

  // In a real React app, you'd use useEffect to listen for theme changes
  // For now, just return the current colors
  return getThemeColors();
}
