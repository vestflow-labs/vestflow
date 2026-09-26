"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import DripsListDetail, { DripsListData } from "@/components/DripsListDetail";
import { DripsMember } from "@/components/DripsListMemberView";

export default function DripsListDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [list, setList] = useState<DripsListData | null>(null);
  const [members, setMembers] = useState<DripsMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setError("");

    try {
      const [listRes, membersRes] = await Promise.all([
        fetch(`/api/lists/${encodeURIComponent(id)}`),
        fetch(`/api/lists/${encodeURIComponent(id)}/members?limit=100`),
      ]);

      if (!listRes.ok) {
        if (listRes.status === 404) throw new Error("Drips list not found");
        throw new Error("Failed to load list details");
      }

      const listData = await listRes.json();
      const membersData = membersRes.ok ? await membersRes.json() : { members: [] };

      setList(listData);
      setMembers(membersData.members || []);
    } catch (e: any) {
      setError(e.message || "Failed to load drips list");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const handleUpdateTargetRate = async (newTarget: string) => {
    if (!id) return;
    const res = await fetch(`/api/lists/${encodeURIComponent(id)}/target-rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_rate_per_sec: newTarget }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || "Failed to update target rate");
    }
  };

  return (
    <>
      <Navbar />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="mb-6">
          <Link
            href="/lists"
            className="text-xs text-zinc-400 hover:text-white transition-colors inline-block mb-3"
          >
            ← Back to Drips Lists
          </Link>
        </div>

        {loading ? (
          <div className="card p-12 text-center text-zinc-400 animate-pulse">
            Loading Drips List…
          </div>
        ) : error || !list ? (
          <div className="card p-12 text-center border-red-500/20 space-y-4">
            <p className="text-red-400 font-semibold">{error || "List not found"}</p>
            <Link href="/lists" className="btn-primary inline-block text-xs px-4 py-2 text-white rounded-lg">
              Explore Other Lists
            </Link>
          </div>
        ) : (
          <DripsListDetail
            list={list}
            members={members}
            onUpdateTargetRate={handleUpdateTargetRate}
          />
        )}
      </main>
    </>
  );
}
