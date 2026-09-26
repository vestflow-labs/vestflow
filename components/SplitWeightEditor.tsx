"use client";

import { useRef, useState } from "react";

export interface EditableSplitReceiver {
  address: string;
  weight_bps: number;
}

/**
 * Reorder receivers by moving the item at `from` to `to`.
 *
 * The dragged receiver keeps its own weight (weights travel with the
 * address); neighbours shift to fill the gap, so their relative order —
 * and therefore the positional distribution — swaps proportionally.
 * Total bps is preserved.
 */
export function reorderReceivers<T extends { weight_bps: number }>(
  list: T[],
  from: number,
  to: number
): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function truncate(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

interface SplitWeightEditorProps {
  receivers: EditableSplitReceiver[];
  onChange?: (next: EditableSplitReceiver[]) => void;
}

export default function SplitWeightEditor({ receivers, onChange }: SplitWeightEditorProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dragFromRef = useRef<number | null>(null);

  const totalBps = receivers.reduce((sum, r) => sum + r.weight_bps, 0);

  function commit(next: EditableSplitReceiver[], from: number, to: number) {
    onChange?.(next);
    const moved = next[to];
    setAnnouncement(
      `Moved ${truncate(moved.address)} from position ${from + 1} to position ${to + 1} of ${next.length}. Weight ${moved.weight_bps} basis points unchanged.`
    );
  }

  function move(from: number, to: number) {
    if (from === to) return;
    const next = reorderReceivers(receivers, from, to);
    if (next === receivers) return;
    commit(next, from, to);
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = e.key === "ArrowUp" ? index - 1 : index + 1;
      if (to < 0 || to >= receivers.length) return;
      move(index, to);
      // Keep focus on the moved row after re-render.
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-split-row="${to}"]`)?.focus();
      });
    }
  }

  return (
    <div>
      <p id="split-dnd-instructions" className="text-xs text-zinc-500 mb-3">
        Drag rows to reorder, or focus a row and use ↑ / ↓ arrow keys. Each
        receiver keeps its weight; neighbours shift proportionally.
      </p>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-sm min-w-[28rem]" aria-describedby="split-dnd-instructions">
          <thead>
            <tr className="text-xs text-zinc-500 uppercase tracking-wider">
              <th className="text-left py-2 px-3" scope="col">
                <span className="sr-only">Drag handle</span>
              </th>
              <th className="text-left py-2 px-3" scope="col">Address</th>
              <th className="text-right py-2 px-3" scope="col">Weight (bps)</th>
              <th className="text-right py-2 px-3" scope="col">Percentage</th>
              <th className="text-right py-2 px-3" scope="col">
                <span className="sr-only">Reorder actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {receivers.map((receiver, i) => {
              const pct = totalBps > 0 ? (receiver.weight_bps / totalBps) * 100 : 0;
              const isDragging = dragIndex === i;
              const isDropTarget = dropIndex === i;
              return (
                <tr
                  key={receiver.address + i}
                  data-split-row={i}
                  tabIndex={0}
                  draggable
                  aria-label={`Receiver ${i + 1} of ${receivers.length}: ${receiver.address}, weight ${receiver.weight_bps} basis points, ${pct.toFixed(1)} percent. Press up or down arrow to reorder.`}
                  aria-grabbed={isDragging}
                  onKeyDown={(e) => handleKeyDown(e, i)}
                  onDragStart={(e) => {
                    dragFromRef.current = i;
                    setDragIndex(i);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(i));
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDropIndex(null);
                    dragFromRef.current = null;
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropIndex !== i) setDropIndex(i);
                  }}
                  onDragLeave={() => {
                    if (dropIndex === i) setDropIndex(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragFromRef.current ?? Number(e.dataTransfer.getData("text/plain"));
                    setDragIndex(null);
                    setDropIndex(null);
                    dragFromRef.current = null;
                    if (Number.isInteger(from)) move(from, i);
                  }}
                  className={`transition-colors outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 rounded ${
                    isDragging
                      ? "opacity-40"
                      : isDropTarget
                        ? "bg-violet-500/10"
                        : "hover:bg-white/[0.02]"
                  }`}
                >
                  <td className="py-2.5 px-3 text-zinc-500 cursor-grab active:cursor-grabbing select-none" aria-hidden="true">
                    <span title="Drag to reorder">⠿</span>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-xs text-zinc-300">
                    {truncate(receiver.address)}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">
                    {receiver.weight_bps.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-zinc-300">
                    {pct.toFixed(1)}%
                  </td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => move(i, i - 1)}
                      disabled={i === 0}
                      aria-label={`Move ${truncate(receiver.address)} up`}
                      className="px-2 py-1 min-h-[32px] min-w-[32px] text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, i + 1)}
                      disabled={i === receivers.length - 1}
                      aria-label={`Move ${truncate(receiver.address)} down`}
                      className="px-2 py-1 min-h-[32px] min-w-[32px] text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
                    >
                      ↓
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
