"use client";

import { FormEvent, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import AddressLabel from "@/components/AddressLabel";
import { DripsListData } from "@/components/DripsListDetail";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/WalletContext";
import {
  addToDripsList,
  connectWallet,
  createDripsList,
  DripsStreamData,
  fundDripsList,
  getDripsStream,
  removeFromDripsList,
  stroopsToXlm,
} from "@/lib/stellar";
import { getTokenSymbol } from "@/lib/tokens";

interface Member {
  address: string;
  joined_at: number;
}

interface ManagedList extends DripsListData {
  members: Member[];
  funders: Array<{ address: string; rate: bigint }>;
}

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export default function MyListsPage() {
  const { publicKey, setPublicKey } = useWallet();
  const { addToast } = useToast();
  const [lists, setLists] = useState<ManagedList[]>([]);
  const [memberListsCount, setMemberListsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listName, setListName] = useState("");
  const [memberInputs, setMemberInputs] = useState<Record<string, string>>({});
  const [fundInputs, setFundInputs] = useState<Record<string, { rate: string; topUp: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const loadLists = async () => {
    if (!publicKey) {
      setLists([]);
      setMemberListsCount(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`/api/lists?owner=${encodeURIComponent(publicKey)}&limit=100`);
      if (!response.ok) throw new Error("Failed to load your Drips lists");
      const data = await response.json();
      const ownerLists = (data.lists || []) as DripsListData[];
      const managed = await Promise.all(ownerLists.map(async list => {
        const membersResponse = await fetch(`/api/lists/${encodeURIComponent(list.id)}/members?limit=100`);
        const membersData = membersResponse.ok ? await membersResponse.json() : { members: [] };
        const members = (membersData.members || []) as Member[];
        const listId = Number(list.id);
        const streams = Number.isFinite(listId)
          ? await Promise.all(members.map(member => getDripsStream(listId, member.address, publicKey)))
          : [];
        const funderRates = new Map<string, bigint>();
        streams.filter(Boolean).forEach((stream: DripsStreamData | null) => {
          if (!stream) return;
          funderRates.set(stream.funder, (funderRates.get(stream.funder) || 0n) + stream.amt_per_sec);
        });
        return {
          ...list,
          members,
          funders: Array.from(funderRates, ([address, rate]) => ({ address, rate })),
        };
      }));
      setLists(managed);

      // Count lists where user is a member (#815)
      try {
        const allListsResponse = await fetch(`/api/lists?limit=1000`);
        if (allListsResponse.ok) {
          const allListsData = await allListsResponse.json();
          const allLists = (allListsData.lists || []) as DripsListData[];
          let memberCount = 0;
          for (const list of allLists) {
            const membersResponse = await fetch(`/api/lists/${encodeURIComponent(list.id)}/members?limit=100`);
            if (membersResponse.ok) {
              const membersData = await membersResponse.json();
              const members = (membersData.members || []) as Member[];
              if (members.some(m => m.address === publicKey)) {
                memberCount++;
              }
            }
          }
          setMemberListsCount(memberCount);
        }
      } catch {
        setMemberListsCount(0);
      }
    } catch (error) {
      addToast({ status: "error", title: "Lists unavailable", message: error instanceof Error ? error.message : "Could not load your lists" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLists();
  }, [publicKey]);

  const connect = async () => {
    try {
      const address = await connectWallet();
      setPublicKey(address);
    } catch (error) {
      addToast({ status: "error", title: "Connection failed", message: error instanceof Error ? error.message : "Could not connect wallet" });
    }
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!publicKey || !listName.trim()) return;
    setBusy("create");
    try {
      await createDripsList(publicKey, listName.trim());
      setListName("");
      addToast({ status: "success", title: "Drips list created", message: "Your new list will appear after the indexer updates." });
      await loadLists();
    } catch (error) {
      addToast({ status: "error", title: "Create failed", message: error instanceof Error ? error.message : "Could not create list" });
    } finally {
      setBusy(null);
    }
  };

  const handleAdd = async (list: ManagedList) => {
    if (!publicKey) return;
    const listId = Number(list.id);
    if (!Number.isSafeInteger(listId)) {
      addToast({ status: "error", title: "Invalid list", message: "This list does not have a valid on-chain ID." });
      return;
    }
    const member = (memberInputs[list.id] || "").trim().toUpperCase();
    if (!STELLAR_ADDRESS_RE.test(member)) {
      addToast({ status: "error", title: "Invalid address", message: "Enter a valid Stellar address." });
      return;
    }
    setBusy(`add:${list.id}`);
    try {
      await addToDripsList(publicKey, listId, member);
      setMemberInputs(current => ({ ...current, [list.id]: "" }));
      addToast({ status: "success", title: "Member added", message: "The list member was added on-chain." });
      await loadLists();
    } catch (error) {
      addToast({ status: "error", title: "Add member failed", message: error instanceof Error ? error.message : "Could not add member" });
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (list: ManagedList, member: string) => {
    const listId = Number(list.id);
    if (!publicKey || !Number.isSafeInteger(listId) || !window.confirm(`Remove ${member} from ${list.name}?`)) return;
    setBusy(`remove:${list.id}:${member}`);
    try {
      await removeFromDripsList(publicKey, listId, member);
      addToast({ status: "success", title: "Member removed", message: "The list member was removed on-chain." });
      await loadLists();
    } catch (error) {
      addToast({ status: "error", title: "Remove member failed", message: error instanceof Error ? error.message : "Could not remove member" });
    } finally {
      setBusy(null);
    }
  };

  const handleFund = async (list: ManagedList) => {
    if (!publicKey) return;
    const values = fundInputs[list.id] || { rate: "", topUp: "" };
    const rate = BigInt(values.rate || "0");
    const topUp = BigInt(values.topUp || "0");
    if (rate <= 0n || topUp < 0n) return;
    setBusy(`fund:${list.id}`);
    try {
      await fundDripsList(publicKey, Number(list.id), list.token, rate, topUp);
      addToast({ status: "success", title: "List funded", message: "Funding was added on-chain." });
      await loadLists();
    } catch (error) {
      addToast({ status: "error", title: "Funding failed", message: error instanceof Error ? error.message : "Could not fund list" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white">My Drips Lists</h1>
            <p className="text-zinc-400 mt-1 text-sm">Manage your recipient lists and see their active funders.</p>
            {publicKey && (
              <div className="flex flex-wrap gap-3 mt-4">
                {lists.length > 0 && (
                  <a href="#owned-lists" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-300 text-sm hover:bg-violet-500/20 transition-colors">
                    📋 {lists.length} {lists.length === 1 ? 'list' : 'lists'} owned
                  </a>
                )}
                {memberListsCount > 0 && (
                  <a href="#member-lists" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm hover:bg-emerald-500/20 transition-colors">
                    👥 Member of {memberListsCount} {memberListsCount === 1 ? 'list' : 'lists'}
                  </a>
                )}
              </div>
            )}
          </div>
          {!publicKey && <button type="button" onClick={connect} className="btn-primary rounded-lg px-4 py-2 text-sm font-semibold text-white">Connect Wallet</button>}
        </div>

        {publicKey && (
          <form onSubmit={handleCreate} className="card p-5 mb-8 flex flex-col sm:flex-row gap-3">
            <input
              value={listName}
              onChange={event => setListName(event.target.value)}
              placeholder="New list name"
              aria-label="New Drips list name"
              className="input flex-1"
              required
            />
            <button type="submit" disabled={busy === "create"} className="btn-primary rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy === "create" ? "Creating..." : "Create list"}
            </button>
          </form>
        )}

        {loading ? (
          <div className="card p-12 text-center text-zinc-400 animate-pulse">Loading your lists...</div>
        ) : !publicKey ? (
          <div className="card p-12 text-center text-zinc-400">Connect your wallet to manage lists you own.</div>
        ) : lists.length === 0 ? (
          <div className="card p-12 text-center text-zinc-400">You do not own any Drips lists yet.</div>
        ) : (
          <div id="owned-lists" className="space-y-6">
            {lists.map(list => (
              <section key={list.id} className="card p-6 space-y-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h2 className="text-xl font-bold text-white">{list.name}</h2>
                    <p className="text-xs text-zinc-500 font-mono mt-1">List ID: {list.id} · {getTokenSymbol(list.token)}</p>
                  </div>
                  <p className="text-sm text-zinc-400">{list.members.length} members</p>
                </div>

                <form onSubmit={event => { event.preventDefault(); handleAdd(list); }} className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={memberInputs[list.id] || ""}
                    onChange={event => setMemberInputs(current => ({ ...current, [list.id]: event.target.value }))}
                    placeholder="Member Stellar address"
                    aria-label={`Add member to ${list.name}`}
                    className="input flex-1 font-mono"
                  />
                  <button type="submit" disabled={busy === `add:${list.id}`} className="rounded-lg border border-violet-500/40 px-4 py-2 text-sm text-violet-300 hover:border-violet-400 disabled:opacity-50">
                    {busy === `add:${list.id}` ? "Adding..." : "Add member"}
                  </button>
                </form>

                <form onSubmit={event => { event.preventDefault(); handleFund(list); }} className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={fundInputs[list.id]?.rate || ""}
                    onChange={event => setFundInputs(current => ({ ...current, [list.id]: { ...(current[list.id] || { topUp: "" }), rate: event.target.value } }))}
                    placeholder="Total rate (stroops/s)"
                    aria-label={`Fund rate for ${list.name}`}
                    inputMode="numeric"
                    className="input flex-1"
                  />
                  <input
                    value={fundInputs[list.id]?.topUp || ""}
                    onChange={event => setFundInputs(current => ({ ...current, [list.id]: { ...(current[list.id] || { rate: "" }), topUp: event.target.value } }))}
                    placeholder="Top-up amount"
                    aria-label={`Fund amount for ${list.name}`}
                    inputMode="numeric"
                    className="input flex-1"
                  />
                  <button type="submit" disabled={busy === `fund:${list.id}`} className="rounded-lg border border-emerald-500/40 px-4 py-2 text-sm text-emerald-300 disabled:opacity-50">
                    {busy === `fund:${list.id}` ? "Funding..." : "Fund list"}
                  </button>
                </form>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-4 border-t border-white/5">
                  <div>
                    <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Members</h3>
                    {list.members.length === 0 ? <p className="text-sm text-zinc-500">No active members.</p> : (
                      <div className="space-y-2">
                        {list.members.map(member => (
                          <div key={member.address} className="flex items-center justify-between gap-3 text-sm">
                            <AddressLabel address={member.address} compact />
                            <button type="button" onClick={() => handleRemove(list, member.address)} disabled={busy === `remove:${list.id}:${member.address}`} className="text-xs text-red-300 hover:text-red-200 disabled:opacity-50">
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Funders and rates</h3>
                    {list.funders.length === 0 ? <p className="text-sm text-zinc-500">No active funders found.</p> : (
                      <div className="space-y-2">
                        {list.funders.map(funder => (
                          <div key={funder.address} className="flex items-center justify-between gap-3 text-sm">
                            <AddressLabel address={funder.address} compact />
                            <span className="font-mono text-emerald-300">{stroopsToXlm(funder.rate)} {getTokenSymbol(list.token)}/s</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
