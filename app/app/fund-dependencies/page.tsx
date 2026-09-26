"use client";
import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { getGrantorScheduleIds, getScheduleBatch, getWalletXlmBalance, stroopsToXlm } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import TopUpModal from "@/components/TopUpModal";

export default function FundDependenciesPage() {
  const { publicKey } = useWallet();
  const [schedules, setSchedules] = useState<any[]>([]);
  const [showTopUp, setShowTopUp] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState<number | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint>(0n);

  useEffect(() => {
    async function load() {
      if (!publicKey) return;
      const ids = await getGrantorScheduleIds(publicKey);
      const all = await getScheduleBatch(ids, publicKey);
      setSchedules(all.filter(Boolean) as any[]);

      const balance = await getWalletXlmBalance(publicKey);
      setWalletBalance(balance);
    }
    load();
  }, [publicKey]);

  const handleTopUp = (scheduleId: number) => {
    setSelectedSchedule(scheduleId);
    setShowTopUp(true);
  };

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-6 pt-24 sm:pt-28 pb-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">Fund Dependencies</h1>
          <p className="text-zinc-400 mt-1">Top up schedules that need funding</p>
        </div>

        {publicKey && (
          <div className="card p-4 mb-6">
            <p className="text-sm text-zinc-500 mb-2">Available XLM balance</p>
            <p className="text-2xl font-bold text-zinc-200">{stroopsToXlm(walletBalance)} XLM</p>
          </div>
        )}

        {schedules.length === 0 ? (
          <p className="text-zinc-500">No schedules found</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {schedules.map((s) => (
              <div key={s.id} className="card p-4">
                <h3 className="font-semibold">Schedule #{s.id}</h3>
                <p className="text-zinc-400">Beneficiary: {s.beneficiary.slice(0, 8)}…{s.beneficiary.slice(-6)}</p>
                <p className="text-zinc-300">Total: {stroopsToXlm(s.total_amount)} XLM</p>
                <p className="text-zinc-300">Claimed: {stroopsToXlm(s.claimed)} XLM</p>
                <p className="text-zinc-300">Remaining: {stroopsToXlm(BigInt(s.total_amount) - s.claimed)} XLM</p>
                <button
                  onClick={() => handleTopUp(s.id)}
                  className="mt-2 btn-primary py-2 text-sm font-semibold"
                >
                  Top Up
                </button>
              </div>
            ))}
          </div>
        )}

        <TopUpModal
          scheduleId={selectedSchedule ?? 0}
          open={showTopUp}
          onClose={() => setShowTopUp(false)}
          onSuccess={() => { setShowTopUp(false); }}
        />
      </main>
    </>
  );
}