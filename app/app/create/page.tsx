"use client";
import { useState } from "react";
import Navbar from "@/components/Navbar";
import CreateForm from "@/components/CreateForm";
import BulkImportForm from "@/components/BulkImportForm";

type Mode = "single" | "bulk";

export default function CreatePage() {
  const [mode, setMode] = useState<Mode>("single");

  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-6 pt-28 pb-20">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Create Vesting Schedule</h1>
          <p className="text-zinc-400 mt-1">Lock tokens and define how they unlock over time.</p>
        </div>

        <div className="flex gap-2 mb-6" role="tablist" aria-label="Schedule creation mode">
          <button
            role="tab"
            aria-selected={mode === "single"}
            onClick={() => setMode("single")}
            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
              mode === "single"
                ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                : "border-white/10 text-zinc-400 hover:text-white"
            }`}
          >
            Single Schedule
          </button>
          <button
            role="tab"
            aria-selected={mode === "bulk"}
            onClick={() => setMode("bulk")}
            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
              mode === "bulk"
                ? "border-violet-500/60 bg-violet-500/10 text-violet-300"
                : "border-white/10 text-zinc-400 hover:text-white"
            }`}
          >
            Bulk CSV Import
          </button>
        </div>

        {mode === "single" ? <CreateForm /> : <BulkImportForm />}
      </main>
    </>
  );
}
