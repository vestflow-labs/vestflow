"use client";
import { QRCodeSVG } from "qrcode.react";
import CopyButton from "@/components/CopyButton";

interface BeneficiaryQrModalProps {
  address: string;
  open: boolean;
  onClose: () => void;
}

export default function BeneficiaryQrModal({
  address,
  open,
  onClose,
}: BeneficiaryQrModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center sm:p-4 p-0"
      role="dialog"
      aria-modal="true"
      aria-label="Beneficiary address QR code"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm card p-6 flex flex-col gap-5 z-10 sm:rounded-2xl rounded-t-2xl sm:m-0 mt-auto max-h-[90vh] overflow-y-auto sm:max-h-none">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Beneficiary Address</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex items-center justify-center bg-white rounded-xl p-4">
          <QRCodeSVG
            value={address}
            size={200}
            marginSize={1}
            title="Beneficiary Stellar address QR code"
          />
        </div>

        <div className="flex flex-col gap-2 items-center">
          <p className="font-mono text-xs text-zinc-400 break-all text-center select-all">
            {address}
          </p>
          <CopyButton value={address} label="Copy beneficiary address" />
        </div>

        <p className="text-xs text-zinc-500 text-center">
          Scan to share this beneficiary&apos;s Stellar address without
          risking a transcription error.
        </p>
      </div>
    </div>
  );
}
