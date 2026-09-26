"use client";

import Link from "next/link";
import { useWallet } from "@/lib/WalletContext";

interface FundProjectButtonProps {
  /** Profile address that becomes the stream receiver. */
  address: string;
}

/**
 * "Fund this project" entry point on a public profile (#812).
 *
 * Links into the Stream Setup form with the profile address pre-filled as the
 * receiver, so a visitor who discovers a developer on their profile can start
 * streaming to them in one click.
 *
 * The button itself never needs a wallet: the Stream Setup form is where the
 * wallet is required, and it renders its own connect prompt when there is none.
 * It is hidden on the viewer's own profile, where there is nothing to discover.
 */
export default function FundProjectButton({ address }: FundProjectButtonProps) {
  const { publicKey } = useWallet();

  // Stellar addresses are upper-case, but compare case-insensitively so a
  // lower-cased key from any source still counts as "own profile".
  const isOwnProfile =
    !!publicKey && !!address && publicKey.toUpperCase() === address.toUpperCase();

  if (isOwnProfile || !address) return null;

  return (
    <Link
      href={`/app/streams/new?beneficiary=${encodeURIComponent(address)}`}
      aria-label={`Fund this project: start a stream to ${address}`}
      title="Start a vesting stream to this account"
      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 min-h-[44px] rounded-lg border transition-all border-violet-500/50 bg-violet-500/10 text-violet-200 hover:border-violet-400 hover:text-white hover:bg-violet-500/20"
    >
      <svg
        aria-hidden="true"
        className="h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M12 5v14M5 12h14"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Fund this project
    </Link>
  );
}
