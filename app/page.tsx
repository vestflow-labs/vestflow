import Link from "next/link";
import Navbar from "@/components/Navbar";
import CopyButton from "@/components/CopyButton";

const features = [
  { icon: "📈", title: "Linear Vesting", desc: "Tokens unlock gradually over the full vesting period — smooth and predictable." },
  { icon: "⏰", title: "Cliff Vesting", desc: "Tokens unlock all at once after a cliff period. Common for team and advisor grants." },
  { icon: "🔄", title: "Revocable Schedules", desc: "Grantors can cancel at any time. Unvested tokens return. Already-vested tokens stay claimable." },
  { icon: "🛡️", title: "Trustless Escrow", desc: "Tokens are locked in the Soroban contract. Neither party can access them outside the rules." },
  { icon: "⚡", title: "Instant Settlement", desc: "Claims settle in 3–5 seconds on Stellar. No waiting, no gas wars." },
  { icon: "🌐", title: "Any SAC Token", desc: "Works with XLM and any Stellar Asset Contract token including USDC." },
];

export default function LandingPage() {
  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-6 pt-32 pb-24">
        <div className="text-center mb-20">
          <div className="inline-flex items-center gap-2 bg-violet-500/10 border border-violet-500/20 rounded-full px-4 py-1.5 text-sm text-violet-300 mb-6">
            <span>🔒</span> Deployed on Stellar Testnet
          </div>
          <h1 className="text-5xl font-bold mb-5 leading-tight">
            Token vesting,<br />
            <span className="gradient-text">done on-chain.</span>
          </h1>
          <p className="text-zinc-400 text-lg max-w-xl mx-auto mb-8">
            Create trustless vesting schedules for your team, advisors, and investors — powered by Soroban smart contracts on Stellar.
          </p>
          <div className="flex gap-4 justify-center">
            <Link href="/app/create" className="btn-primary rounded-xl px-6 py-3 font-semibold text-white">
              Create a Schedule
            </Link>
            <Link href="/app" className="rounded-xl px-6 py-3 font-semibold text-zinc-300 border border-white/10 hover:border-white/20 transition-colors">
              View Dashboard
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f) => (
            <div key={f.title} className="card p-5">
              <div className="text-2xl mb-3">{f.icon}</div>
              <h3 className="font-semibold mb-1.5">{f.title}</h3>
              <p className="text-sm text-zinc-400">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-16 card p-6 text-center">
          <p className="text-sm text-zinc-500 mb-2">Live contract on Stellar Testnet</p>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-center gap-3">
            <a
              href="https://stellar.expert/explorer/testnet/contract/CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-sm text-violet-400 hover:underline break-all"
            >
              CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX
            </a>
            <CopyButton
              value="CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX"
              label="Copy contract address"
              className="self-center"
            />
          </div>
        </div>

        {/* New Features Section */}
        <div className="mt-20">
          <h2 className="text-3xl font-bold mb-10 text-center">Explore More</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Link href="/schedule/0" className="card p-5 hover:bg-zinc-900 transition-colors">
              <div className="text-3xl mb-3">🔗</div>
              <h3 className="font-semibold mb-2">Public Schedules</h3>
              <p className="text-sm text-zinc-400">View and share vesting schedules publicly</p>
            </Link>
            
            <Link href="/analytics" className="card p-5 hover:bg-zinc-900 transition-colors">
              <div className="text-3xl mb-3">📊</div>
              <h3 className="font-semibold mb-2">Analytics</h3>
              <p className="text-sm text-zinc-400">Protocol-level stats and metrics</p>
            </Link>

            <Link href="/widget" className="card p-5 hover:bg-zinc-900 transition-colors">
              <div className="text-3xl mb-3">🧩</div>
              <h3 className="font-semibold mb-2">Embed Widget</h3>
              <p className="text-sm text-zinc-400">Add vesting to your website</p>
            </Link>

            <Link href="/learn" className="card p-5 hover:bg-zinc-900 transition-colors">
              <div className="text-3xl mb-3">📚</div>
              <h3 className="font-semibold mb-2">Learn</h3>
              <p className="text-sm text-zinc-400">Master Soroban smart contracts</p>
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
