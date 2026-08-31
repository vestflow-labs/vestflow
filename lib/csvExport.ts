import { ScheduleData, formatDate, vestingProgress } from "./stellar";

export interface ClaimHistoryItem {
  scheduleId: number;
  claimedAmount: bigint;
  claimDate: number;
  transactionHash?: string;
}

export function buildSchedulesCSV(rows: ScheduleData[]): string {
  const now = Math.floor(Date.now() / 1000);
  const headers = [
    "schedule_id",
    "vesting_kind",
    "grantor",
    "beneficiary",
    "token",
    "total_amount_xlm",
    "vested_amount_xlm",
    "claimed_amount_xlm",
    "remaining_amount_xlm",
    "progress_percentage",
    "start_date",
    "end_date",
    "cliff_date",
    "revocable",
    "revoked",
    "status",
  ];
  
  const escape = (v: string | number | boolean) =>
    `"${String(v).replace(/"/g, '""')}"`;

  const dataRows = rows.map((s) => {
    const progress = vestingProgress(s, now);
    const vestedXlm = (Number(s.total_amount) * progress) / 100 / 10_000_000;
    const totalXlm = Number(s.total_amount) / 10_000_000;
    const claimedXlm = Number(s.claimed) / 10_000_000;
    const remainingXlm = totalXlm - claimedXlm;
    
    const status = s.revoked
      ? "Revoked"
      : progress >= 100
      ? "Fully Vested"
      : now < s.start_time
      ? "Pending"
      : "Vesting";

    return [
      s.id,
      s.kind,
      s.grantor,
      s.beneficiary,
      s.token,
      totalXlm.toFixed(7),
      vestedXlm.toFixed(7),
      claimedXlm.toFixed(7),
      remainingXlm.toFixed(7),
      progress.toFixed(2),
      formatDate(s.start_time),
      formatDate(s.start_time + s.duration),
      s.cliff_duration > 0 ? formatDate(s.start_time + s.cliff_duration) : "N/A",
      s.revocable,
      s.revoked,
      status,
    ]
      .map(escape)
      .join(",");
  });

  return [headers.map(escape).join(","), ...dataRows].join("\n");
}

export function buildClaimHistoryCSV(
  schedules: ScheduleData[],
  claimHistory?: ClaimHistoryItem[]
): string {
  const headers = [
    "schedule_id",
    "grantor",
    "beneficiary",
    "total_amount_xlm",
    "claimed_amount_xlm",
    "claim_percentage",
    "vesting_kind",
    "start_date",
    "status",
  ];

  const escape = (v: string | number | boolean) =>
    `"${String(v).replace(/"/g, '""')}"`;

  const now = Math.floor(Date.now() / 1000);
  
  const dataRows = schedules
    .filter((s) => s.claimed > 0n)
    .map((s) => {
      const totalXlm = Number(s.total_amount) / 10_000_000;
      const claimedXlm = Number(s.claimed) / 10_000_000;
      const claimPercentage = totalXlm > 0 ? (claimedXlm / totalXlm) * 100 : 0;
      const progress = vestingProgress(s, now);
      
      const status = s.revoked
        ? "Revoked"
        : progress >= 100
        ? "Fully Vested"
        : "Vesting";

      return [
        s.id,
        s.grantor,
        s.beneficiary,
        totalXlm.toFixed(7),
        claimedXlm.toFixed(7),
        claimPercentage.toFixed(2),
        s.kind,
        formatDate(s.start_time),
        status,
      ]
        .map(escape)
        .join(",");
    });

  if (dataRows.length === 0) {
    return [headers.map(escape).join(","), '"No claim history available"'].join("\n");
  }

  return [headers.map(escape).join(","), ...dataRows].join("\n");
}

export function buildCombinedExportCSV(schedules: ScheduleData[]): string {
  const schedulesCSV = buildSchedulesCSV(schedules);
  const claimHistoryCSV = buildClaimHistoryCSV(schedules);
  
  return `VESTING SCHEDULES\n${schedulesCSV}\n\n\nCLAIM HISTORY\n${claimHistoryCSV}`;
}

export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Downloads arbitrary JSON — used for the Merkle batch proof file each beneficiary needs to self-claim. */
export function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
