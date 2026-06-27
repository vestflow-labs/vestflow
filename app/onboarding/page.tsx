"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isConnected } from "@stellar/freighter-api";
import Navbar from "@/components/Navbar";
import { connectWallet } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

const TOTAL_STEPS = 4;
const ONBOARDING_KEY = "vestflow-onboarding";

function ProgressDots({ step }: { step: number }) {
  return (
    <div
      className="flex items-center gap-2 justify-center mb-8"
      aria-label={`Step ${step} of ${TOTAL_STEPS}`}
    >
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <span
          key={i}
          className={`w-2 h-2 rounded-full transition-colors ${
            i < step ? "bg-violet-500" : "bg-zinc-700"
          }`}
        />
      ))}
    </div>
  );
}

function StepHeader({ emoji, title, description }: { emoji: string; title: string; description: string }) {
  return (
    <div className="text-center">
      <p className="text-4xl mb-4">{emoji}</p>
      <h1 className="text-2xl font-bold mb-2">{title}</h1>
      <p className="text-zinc-400 text-sm leading-relaxed">{description}</p>
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-center">
      {message}
    </p>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="btn-primary rounded-xl py-3 font-semibold text-white text-sm disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function StepInstallFreighter({
  err,
  checking,
  onCheck,
}: {
  err: string;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        emoji="🔐"
        title="First, install Freighter"
        description="Freighter is a browser extension wallet for the Stellar network. You'll need it to sign transactions on VestFlow."
      />
      <ErrorMessage message={err} />
      
        href="https://www.freighter.app"
        target="_blank"
        rel="noopener noreferrer"
        className="btn-primary rounded-xl py-3 font-semibold text-white text-center text-sm"
      >
        Get Freighter →
      </a>
      <button
        onClick={onCheck}
        disabled={checking}
        className="rounded-xl py-3 border border-white/10 text-zinc-400 hover:text-white transition-colors text-sm font-semibold disabled:opacity-40"
      >
        {checking ? "Checking…" : "I've installed it →"}
      </button>
    </div>
  );
}

function StepConnectWallet({
  err,
  connecting,
  onConnect,
}: {
  err: string;
  connecting: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        emoji="🔗"
        title="Connect your wallet"
        description="Allow VestFlow to read your Stellar address. You'll approve each transaction individually — we never have access to your keys."
      />
      <ErrorMessage message={err} />
      <PrimaryButton onClick={onConnect} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect Wallet"}
      </PrimaryButton>
    </div>
  );
}

const VESTING_POINTS = [
  { title: "Linear vesting", body: "tokens unlock continuously from start to end date." },
  { title: "Cliff period", body: "no tokens are available until the cliff date is reached." },
  { title: "Revocable schedules", body: "the creator can cancel early; unvested tokens return to them." },
  { title: "Claim any time", body: "recipients can claim vested tokens whenever they like." },
];

function StepHowItWorks({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        emoji="📈"
        title="How token vesting works"
        description="Vesting gradually releases tokens to a recipient over time — no middleman required."
      />
      <ul className="flex flex-col gap-3 text-sm text-zinc-300">
        {VESTING_POINTS.map(({ title, body }) => (
          <li key={title} className="flex items-start gap-3">
            <span className="text-violet-400 mt-0.5">●</span>
            <span>
              <strong className="text-white">{title}</strong> — {body}
            </span>
          </li>
        ))}
      </ul>
      <PrimaryButton onClick={onNext}>Got it →</PrimaryButton>
    </div>
  );
}

function StepReady({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="flex flex-col gap-5 text-center">
      <StepHeader
        emoji="🎉"
        title="You're all set!"
        description="Head to your dashboard to create your first vesting schedule or view existing ones."
      />
      <PrimaryButton onClick={onFinish}>Go to Dashboard →</PrimaryButton>
    </div>
  );
}

export default function OnboardingPage() {
  const { publicKey, setPublicKey } = useWallet();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [checkingFreighter, setCheckingFreighter] = useState(false);

  useEffect(() => {
    if (publicKey) {
      setStep(3);
      return;
    }
    isConnected()
      .then((installed) => setStep(installed ? 2 : 1))
      .catch(() => setStep(1));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const checkFreighterInstalled = async () => {
    setCheckingFreighter(true);
    setErr("");
    try {
      const installed = await isConnected();
      if (installed) {
        setStep(2);
      } else {
        setErr("Freighter not detected. Please install it and refresh the page.");
      }
    } catch {
      setErr("Could not detect Freighter. Try refreshing the page.");
    } finally {
      setCheckingFreighter(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setErr("");
    try {
      const addr = await connectWallet();
      setPublicKey(addr);
      setStep(3);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleFinish = () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "done");
    } catch {
      // localStorage may be unavailable; continue anyway
    }
    router.push("/app");
  };

  if (step === 0) return null;

  return (
    <>
      <Navbar />
      <main className="min-h-screen flex items-center justify-center px-4 pt-24 pb-20">
        <div className="w-full max-w-md card p-8 flex flex-col">
          <ProgressDots step={step} />

          {step === 1 && (
            <StepInstallFreighter
              err={err}
              checking={checkingFreighter}
              onCheck={checkFreighterInstalled}
            />
          )}
          {step === 2 && (
            <StepConnectWallet
              err={err}
              connecting={connecting}
              onConnect={handleConnect}
            />
          )}
          {step === 3 && <StepHowItWorks onNext={() => setStep(4)} />}
          {step === 4 && <StepReady onFinish={handleFinish} />}
        </div>
      </main>
    </>
  );
}
