"use client";
import Navbar from "@/components/Navbar";
import TransactionHistory from "@/components/TransactionHistory";
import Link from "next/link";

export default function HistoryPage() {
  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold">Transaction History</h1>
            <p className="text-zinc-400 mt-1">Streams, gives, collects, and splits for your wallet</p>
          </div>
          <Link href="/app" className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-2 transition-colors">
            ← Back to Dashboard
          </Link>
        </div>
        <TransactionHistory />
      </main>
    </>
  );
}
