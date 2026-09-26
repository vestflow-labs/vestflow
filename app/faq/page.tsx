"use client";
import Navbar from "@/components/Navbar";
import Link from "next/link";
import { useState } from "react";

interface FAQItem {
  question: string;
  answer: React.ReactNode;
}

const faqs: FAQItem[] = [
  {
    question: "What is VestFlow?",
    answer: (
      <p>
        VestFlow is a trustless token vesting platform built on Stellar / Soroban. It lets a
        grantor lock tokens into a smart contract and release them to a beneficiary over time —
        linearly, all-at-once after a cliff, or a combination of both. No custodian or
        intermediary is involved; the contract enforces every rule automatically.
      </p>
    ),
  },
  {
    question: "What happens if I lose access to my wallet?",
    answer: (
      <div className="flex flex-col gap-2">
        <p>
          Your wallet&apos;s secret key (or recovery phrase) is the only way to authorize
          transactions. VestFlow has no admin key and cannot recover access on your behalf.
        </p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>
            <strong className="text-zinc-300">As a beneficiary:</strong> if you lose your wallet
            you lose the ability to claim vested tokens. Back up your Freighter recovery phrase
            in a secure, offline location before creating or receiving any schedule.
          </li>
          <li>
            <strong className="text-zinc-300">As a grantor:</strong> you lose the ability to
            revoke a revocable schedule. Tokens already locked in the contract remain there and
            can still be claimed by the beneficiary.
          </li>
        </ul>
        <p className="text-zinc-400 text-sm">
          Stellar accounts support multisig — consider adding a backup signer to your account
          for high-value schedules.
        </p>
      </div>
    ),
  },
  {
    question: "Can the grantor rug-pull or steal my tokens?",
    answer: (
      <div className="flex flex-col gap-2">
        <p>
          It depends on whether the schedule was created as <strong>revocable</strong> or{" "}
          <strong>irrevocable</strong>.
        </p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>
            <strong className="text-zinc-300">Irrevocable schedule:</strong> once created, the
            grantor has zero ability to touch the locked tokens. The contract enforces this
            on-chain — there is no admin override.
          </li>
          <li>
            <strong className="text-zinc-300">Revocable schedule:</strong> the grantor can cancel
            the schedule at any time. However, they only recover the <em>unvested</em> portion.
            Any tokens that have already vested remain claimable by the beneficiary forever.
          </li>
        </ul>
        <p className="text-zinc-400 text-sm">
          Always check the &quot;Revocable&quot; field on a schedule before accepting it.
        </p>
      </div>
    ),
  },
  {
    question: "What fees are involved?",
    answer: (
      <div className="flex flex-col gap-2">
        <p>VestFlow itself charges no protocol fee. The only costs are Stellar network fees:</p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>
            <strong className="text-zinc-300">Transaction fee:</strong> a small XLM fee paid to
            Stellar validators for each on-chain operation (create, claim, revoke). Typically a
            fraction of a cent.
          </li>
          <li>
            <strong className="text-zinc-300">Soroban resource fee:</strong> Soroban smart
            contract calls include a resource fee based on compute and storage used. For typical
            vesting operations this is also very small (usually under 0.01 XLM).
          </li>
          <li>
            <strong className="text-zinc-300">Minimum balance reserve:</strong> Stellar accounts
            must maintain a minimum XLM balance. No additional reserve is required by VestFlow
            beyond what Stellar itself mandates.
          </li>
        </ul>
      </div>
    ),
  },
  {
    question: "What is the difference between Linear, Cliff, and Linear+Cliff vesting?",
    answer: (
      <ul className="list-disc list-inside text-zinc-400 space-y-2">
        <li>
          <strong className="text-zinc-300">Linear:</strong> tokens unlock continuously and
          evenly from the start date to the end date. At any point the beneficiary can claim
          the proportional amount that has elapsed.
        </li>
        <li>
          <strong className="text-zinc-300">Cliff:</strong> zero tokens are available until the
          cliff date, then the entire amount unlocks at once.
        </li>
        <li>
          <strong className="text-zinc-300">Linear with Cliff:</strong> zero tokens until the
          cliff date, then linear release from the cliff to the end date. This models the
          classic employee vesting schedule (e.g. 1-year cliff, then monthly vesting over 3
          years).
        </li>
      </ul>
    ),
  },
  {
    question: "Can I use a multisig account or DAO treasury as the beneficiary?",
    answer: (
      <div className="flex flex-col gap-2">
        <p>
          Yes. The beneficiary field accepts any valid Stellar account address, including
          multisig accounts and DAO treasury accounts. Stellar&apos;s native multisig support
          means the contract&apos;s <code className="text-violet-300">beneficiary.require_auth()</code>{" "}
          check is satisfied as long as the transaction carries the required threshold of
          signatures for that account.
        </p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1 text-sm">
          <li>
            All signers must coordinate to submit the{" "}
            <code className="text-violet-300">claim</code> transaction with the required weight.
          </li>
          <li>
            Freighter currently supports single-key signing. For multisig claims, use the
            Stellar CLI or a multisig-capable wallet (Lobstr, StellarTerm) to build and
            co-sign the transaction.
          </li>
          <li>
            Soroban contract addresses (e.g. a DAO contract) can also be set as the beneficiary
            if the contract implements the Soroban auth interface. Verify the DAO contract
            supports <code className="text-violet-300">require_auth</code> before creating the
            schedule.
          </li>
        </ul>
        <p className="text-zinc-400 text-sm">
          See the{" "}
          <a
            href="https://developers.stellar.org/docs/learn/encyclopedia/security/signatures-multisig"
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-400 hover:underline"
          >
            Stellar multisig documentation
          </a>{" "}
          for details on setting up threshold signing.
        </p>
      </div>
    ),
  },
  {
    question: "When can I claim tokens?",
    answer: (
      <p>
        You can call <strong>Claim</strong> at any time after tokens have vested. There is no
        deadline — vested tokens remain claimable indefinitely, even after the schedule end
        date. The contract transfers exactly the amount that has vested minus what you have
        already claimed.
      </p>
    ),
  },
  {
    question: "What happens to tokens if a schedule is revoked?",
    answer: (
      <div className="flex flex-col gap-2">
        <p>
          When a grantor revokes a revocable schedule the contract calculates the vested amount
          at that exact moment:
        </p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>
            <strong className="text-zinc-300">Vested tokens</strong> are automatically released
            to the beneficiary at the moment of revocation.
          </li>
          <li>
            <strong className="text-zinc-300">Unvested tokens</strong> are immediately returned
            to the grantor in the same transaction.
          </li>
        </ul>
        <p className="text-zinc-400 text-sm">
          A revoked schedule cannot be un-revoked. The grantor cannot revoke an irrevocable
          schedule under any circumstances.
        </p>
      </div>
    ),
  },
  {
    question: "Is VestFlow audited? Is it safe to use on mainnet?",
    answer: (
      <div className="flex flex-col gap-2">
        <p>
          VestFlow is currently deployed on <strong>Stellar Testnet</strong> and has not yet
          undergone a formal third-party security audit. The contract is open-source and
          available for review.
        </p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1 text-sm">
          <li>
            Review the contract source in{" "}
            <code className="text-violet-300">contracts/vestflow/src/lib.rs</code>.
          </li>
          <li>
            Run the full test suite:{" "}
            <code className="text-violet-300">cd contracts/vestflow &amp;&amp; cargo test</code>.
          </li>
          <li>Commission an independent audit for high-value deployments.</li>
        </ul>
      </div>
    ),
  },
  {
    question: "How do I verify a transaction on-chain?",
    answer: (
      <p>
        Every transaction hash shown in VestFlow links directly to{" "}
        <a
          href="https://stellar.expert"
          target="_blank"
          rel="noopener noreferrer"
          className="text-violet-400 hover:underline"
        >
          Stellar Expert
        </a>
        , the canonical Stellar block explorer. Click any transaction hash in the UI to open
        the full on-chain details, including operations, effects, and ledger state changes.
      </p>
    ),
  },
  {
    question: 'Why am I seeing "Schedule not found"?',
    answer: (
      <p>
        This error comes from <code className="text-violet-300">get_schedule</code>,{" "}
        <code className="text-violet-300">claim</code>, or <code className="text-violet-300">revoke</code>{" "}
        being called with a schedule ID that does not exist on-chain. Double-check the ID —
        schedule IDs are assigned sequentially starting at 1 when a schedule is created.
      </p>
    ),
  },
  {
    question: 'Why does "Claim" fail with "Nothing to claim yet"?',
    answer: (
      <p>
        The contract only lets you claim tokens that have actually vested. If the schedule
        has a cliff, nothing is claimable before the cliff date. If you have already claimed
        everything that has vested so far, you&apos;ll need to wait for more time to elapse
        before claiming again.
      </p>
    ),
  },
  {
    question: 'Why can\'t I revoke a schedule ("Schedule is not revocable" / "Already revoked")?',
    answer: (
      <div className="flex flex-col gap-2">
        <p>Revocation fails for one of two reasons:</p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>
            <strong className="text-zinc-300">&quot;Schedule is not revocable&quot;:</strong> the
            schedule was created as irrevocable. This is permanent — no admin override exists.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;Already revoked&quot;:</strong> the schedule
            was already revoked once. A schedule can only be revoked a single time.
          </li>
        </ul>
      </div>
    ),
  },
  {
    question: 'Why does "Create Schedule" reject my inputs?',
    answer: (
      <div className="flex flex-col gap-2">
        <p>
          <code className="text-violet-300">create_schedule</code> validates its parameters
          on-chain before locking any tokens. Common validation errors:
        </p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>
            <strong className="text-zinc-300">&quot;Amount must be positive&quot;:</strong> the
            total amount to vest is zero or negative.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;Duration must be positive&quot;:</strong> the
            schedule duration is zero.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;Cliff cannot exceed duration&quot;:</strong>{" "}
            the cliff period is longer than the total vesting duration.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;Lockup cannot be less than cliff&quot;:</strong>{" "}
            the lockup duration is shorter than the cliff duration.
          </li>
          <li>
            <strong className="text-zinc-300">
              &quot;Beneficiary must differ from grantor&quot;:
            </strong>{" "}
            you cannot create a schedule where you are both the grantor and the beneficiary.
          </li>
          <li>
            <strong className="text-zinc-300">
              &quot;Start time cannot be in the past&quot;:
            </strong>{" "}
            the chosen start time is earlier than the current ledger time.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;Invalid token&quot;:</strong> the token
            address is not a recognised Stellar Asset Contract.
          </li>
        </ul>
      </div>
    ),
  },
  {
    question: 'Why does "Claim" fail with "Insufficient balance or below minimum reserve"?',
    answer: (
      <p>
        Token transfers on Stellar must respect the account&apos;s minimum balance reserve.
        This error means the transfer of vested tokens would leave the contract or recipient
        account below the balance Stellar requires it to maintain. It usually resolves itself
        once the relevant account holds enough of a reserve, or by claiming a smaller amount
        if the schedule supports partial claims.
      </p>
    ),
  },
  {
    question: "What are the contract upgrade errors I might see as a grantor or beneficiary?",
    answer: (
      <div className="flex flex-col gap-2">
        <p>
          VestFlow supports a time-locked, authority-gated upgrade process for the contract
          itself. These errors relate to that process, not to individual vesting schedules:
        </p>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>
            <strong className="text-zinc-300">
              &quot;Upgrade authority already initialized&quot;:
            </strong>{" "}
            the upgrade authority was already set and cannot be set again.
          </li>
          <li>
            <strong className="text-zinc-300">
              &quot;Upgrade authority not initialized&quot;:
            </strong>{" "}
            an upgrade was announced or executed before an authority was configured.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;Unauthorized upgrade authority&quot;:</strong>{" "}
            the transaction was not signed by the configured upgrade authority address.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;No pending upgrade&quot;:</strong> execution
            or cancellation was attempted without an upgrade having been announced first.
          </li>
          <li>
            <strong className="text-zinc-300">&quot;Upgrade timelock still active&quot;:</strong>{" "}
            an announced upgrade must wait 48 hours before it can be executed, as a safety
            window for the community to review the change.
          </li>
        </ul>
      </div>
    ),
  },
  {
    question:
      'Why do I get "Performance oracle must be initialized before enabling milestones"?',
    answer: (
      <p>
        Performance-based milestone vesting requires an oracle to be configured first via{" "}
        <code className="text-violet-300">initialize_performance_oracle</code>. Calling{" "}
        <code className="text-violet-300">enable_performance_milestones</code> before that
        step will fail with this error — set up the oracle first, then enable milestones.
      </p>
    ),
  },
];

function FAQAccordion({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-zinc-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/3 transition-colors"
        aria-expanded={open}
      >
        <span className="font-medium text-zinc-100">{item.question}</span>
        <span
          className={`text-zinc-400 text-lg transition-transform duration-200 ${open ? "rotate-45" : ""}`}
          aria-hidden="true"
        >
          +
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5 text-sm text-zinc-300 leading-relaxed border-t border-zinc-800 pt-4">
          {item.answer}
        </div>
      )}
    </div>
  );
}

export default function FAQPage() {
  return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 pt-28 pb-20 flex flex-col gap-8">
        <div>
          <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">
            ← Home
          </Link>
          <h1 className="text-3xl font-bold mt-4 mb-2">Frequently Asked Questions</h1>
          <p className="text-zinc-400">
            Common questions about how VestFlow works, what protections exist, and how to use
            it safely.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {faqs.map((item) => (
            <FAQAccordion key={item.question} item={item} />
          ))}
        </div>

        <div className="card p-6 border-violet-500/20 bg-violet-500/5 text-sm text-zinc-400">
          <p>
            Still have questions?{" "}
            <a
              href="https://github.com/libby-coder/vestflow/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-400 hover:underline"
            >
              Open an issue on GitHub
            </a>{" "}
            or join the{" "}
            <a
              href="https://discord.gg/stellardev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-400 hover:underline"
            >
              Stellar Discord
            </a>
            .
          </p>
        </div>
      </main>
    </>
  );
}
