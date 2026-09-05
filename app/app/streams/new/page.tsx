"use client";
import { useState } from "react";
import Navbar from "@/components/Navbar";
import CreateForm from "@/components/CreateForm";

export default function StreamsNewPage() {
  const [step, setStep] = useState<"form" | "confirm" | "done">("form");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState("");

  const handleCreate = async () => {
    setStatus("loading");
    // Use CreateForm flow simplified for streams/new
    setStep("confirm");
  };

  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-6 pt-28 pb-20">
        <div>
          <h1 className="text-3xl font-bold">New Stream</h1>
          <p className="text-zinc-400 mt-1">Create a new vesting schedule</p>
        </div>

        {step === "form" && <CreateForm />}
        {step === "confirm" && (
          <div className="card p-6">
            <h2 className="text-lg font-semibold">Confirm Schedule</h2>
            <p className="text-zinc-500 mb-4">
              Review the schedule details before creating. The form above contains all fields.
            </p>
            <button
              onClick={() => setStep("form")}
              className="mb-2 btn-primary py-2 text-sm font-semibold"
            >
              ← Back to Form
            </button>
          </div>
        )}
        {step === "done" && (
          <div className="card p-8 text-center">
            <div className="text-4xl" aria-hidden="true">✅</div>
            <p className="text-green-400 font-semibold">Schedule Created!</p>
            <div className="mt-4">
              <a href="/app" className="text-violet-400 hover:text-violet-300 transition-colors">
                View Dashboard
              </a>
            </div>
          </div>
        )}
      </main>
    </>
  );
}