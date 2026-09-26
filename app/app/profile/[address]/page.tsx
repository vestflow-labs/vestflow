import Link from "next/link";
import Navbar from "@/components/Navbar";
import { NETWORK } from "@/lib/stellar";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const decoded = decodeURIComponent(address);

  return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 pt-28 pb-20">
        <Link href="/app" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
          ← Dashboard
        </Link>

        <section className="card p-6 mt-6">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Counterparty Profile</p>
          <h1 className="text-2xl font-bold mb-3">Stellar Account</h1>
          <p className="font-mono text-sm text-zinc-300 break-all">{decoded}</p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={`/app/history?address=${encodeURIComponent(decoded)}`}
              className="rounded-lg px-4 py-2 text-sm border border-white/10 text-zinc-300 hover:text-white hover:border-white/20 transition-colors"
            >
              View history
            </Link>
            <a
              href={`https://stellar.expert/explorer/${NETWORK}/account/${decoded}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg px-4 py-2 text-sm border border-violet-500/30 text-violet-300 hover:border-violet-500/60 transition-colors"
            >
              View on Stellar Expert
            </a>
          </div>
        </section>
      </main>
    </>
  );
}
