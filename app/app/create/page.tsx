import Navbar from "@/components/Navbar";
import CreateForm from "@/components/CreateForm";

export default function CreatePage() {
  return (
    <>
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 sm:px-6 pt-28 pb-20">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Create Vesting Schedule</h1>
          <p className="text-zinc-400 mt-1">Lock tokens and define how they unlock over time.</p>
        </div>
        <CreateForm />
      </main>
    </>
  );
}
