"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ScheduleData, stroopsToXlm } from "@/lib/stellar";

interface TreeNode {
  address: string;
  totalRate: bigint;
  scheduleCount: number;
  type: "center" | "outgoing" | "incoming";
}

interface DependencyTreeProps {
  address: string;
  schedules: ScheduleData[];
}

export default function DependencyTree({ address, schedules }: DependencyTreeProps) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);

  useEffect(() => {
    const outgoing = new Map<string, { rate: bigint; count: number }>();
    const incoming = new Map<string, { rate: bigint; count: number }>();

    for (const s of schedules) {
      if (!s.revoked) {
        const duration = s.duration > 0 ? s.duration : 1;
        const ratePerSec = s.total_amount / BigInt(duration);

        if (s.grantor === address) {
          const current = outgoing.get(s.beneficiary) ?? { rate: 0n, count: 0 };
          outgoing.set(s.beneficiary, {
            rate: current.rate + ratePerSec,
            count: current.count + 1,
          });
        }

        if (s.beneficiary === address) {
          const current = incoming.get(s.grantor) ?? { rate: 0n, count: 0 };
          incoming.set(s.grantor, {
            rate: current.rate + ratePerSec,
            count: current.count + 1,
          });
        }
      }
    }

    const allNodes: TreeNode[] = [
      { address, type: "center", totalRate: 0n, scheduleCount: 0 },
    ];

    const outgoingArray = Array.from(outgoing.entries())
      .sort((a, b) => Number(b[1].rate - a[1].rate))
      .slice(0, 10)
      .map(([addr, data]) => ({
        address: addr,
        type: "outgoing" as const,
        totalRate: data.rate,
        scheduleCount: data.count,
      }));

    const incomingArray = Array.from(incoming.entries())
      .sort((a, b) => Number(b[1].rate - a[1].rate))
      .slice(0, 10)
      .map(([addr, data]) => ({
        address: addr,
        type: "incoming" as const,
        totalRate: data.rate,
        scheduleCount: data.count,
      }));

    setNodes([...incomingArray, ...allNodes, ...outgoingArray]);
  }, [address, schedules]);

  if (nodes.length <= 1) return null;

  const width = 1000;
  const height = 300;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = 120;

  const incomingNodes = nodes.filter(n => n.type === "incoming");
  const outgoingNodes = nodes.filter(n => n.type === "outgoing");
  const centerNode = nodes.find(n => n.type === "center")!;

  const positions = new Map<string, { x: number; y: number }>();
  positions.set(centerNode.address, { x: centerX, y: centerY });

  incomingNodes.forEach((node, i) => {
    const angle = (Math.PI / (incomingNodes.length + 1)) * (i + 1) - Math.PI / 2;
    positions.set(node.address, {
      x: centerX - radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    });
  });

  outgoingNodes.forEach((node, i) => {
    const angle = (Math.PI / (outgoingNodes.length + 1)) * (i + 1) + Math.PI / 2;
    positions.set(node.address, {
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    });
  });

  const truncateAddress = (addr: string) => `${addr.slice(0, 10)}...${addr.slice(-4)}`;

  return (
    <div className="card p-6 mb-6">
      <h2 className="text-lg font-semibold mb-4">Stream Network</h2>
      <div className="overflow-x-auto -mx-6 px-6">
        <svg width={width} height={height} className="min-w-full" viewBox={`0 0 ${width} ${height}`}>
          {/* Draw edges */}
          {nodes.map(node => {
            if (node.type === "center") return null;
            const from = positions.get(node.address);
            const to = positions.get(centerNode.address);
            if (!from || !to) return null;

            const isOutgoing = node.type === "outgoing";
            const opacity = 0.3;

            return (
              <g key={`edge-${node.address}`}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={isOutgoing ? "#ef4444" : "#10b981"}
                  strokeWidth="2"
                  opacity={opacity}
                />
                <defs>
                  <marker
                    id={`arrow-${node.address}`}
                    markerWidth="10"
                    markerHeight="10"
                    refX="8"
                    refY="3"
                    orient="auto"
                    markerUnits="strokeWidth"
                  >
                    <path
                      d="M0,0 L0,6 L9,3 z"
                      fill={isOutgoing ? "#ef4444" : "#10b981"}
                      opacity={opacity}
                    />
                  </marker>
                </defs>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={isOutgoing ? "#ef4444" : "#10b981"}
                  strokeWidth="2"
                  opacity={opacity}
                  markerEnd={`url(#arrow-${node.address})`}
                />
              </g>
            );
          })}

          {/* Draw nodes */}
          {nodes.map(node => {
            const pos = positions.get(node.address);
            if (!pos) return null;

            const isCenter = node.type === "center";
            const isOutgoing = node.type === "outgoing";
            const radius = isCenter ? 16 : 14;
            const bgColor = isCenter ? "#7c3aed" : isOutgoing ? "#ef4444" : "#10b981";
            const ratePerDay = stroopsToXlm(node.totalRate * 86400n);

            return (
              <g key={`node-${node.address}`}>
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={radius}
                  fill={bgColor}
                  opacity="0.8"
                  className="cursor-pointer hover:opacity-100 transition-opacity"
                />
                <foreignObject x={pos.x - 45} y={pos.y + 25} width="90" height="60">
                  <Link
                    href={`/profile/${encodeURIComponent(node.address)}`}
                    className="block text-center text-xs text-zinc-300 hover:text-white transition-colors"
                  >
                    <div className="font-mono">{truncateAddress(node.address)}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      {ratePerDay} XLM/d
                    </div>
                  </Link>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-4 flex items-center gap-6 text-xs text-zinc-500">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-emerald-500" />
          <span>Incoming</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span>Outgoing</span>
        </div>
      </div>
    </div>
  );
}
