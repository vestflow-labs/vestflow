"use client";
import { QRCodeSVG } from "qrcode.react";
import CopyButton from "@/components/CopyButton";
import { useRef } from "react";

interface WalletQrModalProps {
  address: string;
  open: boolean;
  onClose: () => void;
}

export default function WalletQrModal({
  address,
  open,
  onClose,
}: WalletQrModalProps) {
  const qrRef = useRef<HTMLDivElement>(null);

  const handleDownload = () => {
    if (!qrRef.current) return;
    const svg = qrRef.current.querySelector("svg");
    if (!svg) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const svgData = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      
      canvas.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement("a");
        link.download = `wallet-${address.slice(0, 8)}.png`;
        link.href = URL.createObjectURL(blob);
        link.click();
        URL.revokeObjectURL(link.href);
      });
      URL.revokeObjectURL(url);
    };

    img.src = url;
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center sm:p-4 p-0"
      role="dialog"
      aria-modal="true"
      aria-label="Wallet address QR code"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm card p-6 flex flex-col gap-5 z-10 sm:rounded-2xl rounded-t-2xl sm:m-0 mt-auto max-h-[90vh] overflow-y-auto sm:max-h-none">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Wallet Address</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div ref={qrRef} className="flex items-center justify-center bg-white rounded-xl p-4">
          <QRCodeSVG
            value={address}
            size={200}
            marginSize={1}
            title="Wallet Stellar address QR code"
          />
        </div>

        <div className="flex flex-col gap-2 items-center">
          <p className="font-mono text-xs text-zinc-400 break-all text-center select-all">
            {address}
          </p>
          <div className="flex gap-2">
            <CopyButton value={address} label="Copy wallet address" />
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-white/10 rounded-lg hover:border-white/20 transition-colors text-zinc-400 hover:text-white"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download PNG
            </button>
          </div>
        </div>

        <p className="text-xs text-zinc-500 text-center">
          Scan to share your wallet address or save the QR code for easy sharing.
        </p>
      </div>
    </div>
  );
}
