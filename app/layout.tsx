import type { Metadata } from "next";
import { WalletProvider } from "@/lib/WalletContext";
import { ToastProvider } from "@/components/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "VestFlow — Token Vesting on Stellar",
  description: "Create and manage token vesting schedules on the Stellar network using Soroban smart contracts.",
  viewport: {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
  },
};

// Inlined before React hydration so the correct class is applied
// synchronously — avoids a flash of the wrong theme.
const themeScript = `(function(){try{var t=localStorage.getItem('vestflow-theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme:dark)').matches);if(d){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning prevents React from complaining when the
    // inline script mutates the class attribute before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased" style={{ fontFamily: "system-ui, sans-serif" }}>
        <WalletProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletProvider>
      </body>
    </html>
  );
}