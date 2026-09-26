import { Metadata } from "next";
import { getSchedule, NETWORK, vestingProgress } from "@/lib/stellar";
import ScheduleView from "./ScheduleView";

interface SchedulePageProps {
  params: Promise<{ id: string }>;
}

function formatAmount(amount: string): string {
  const whole = BigInt(amount) / 10_000_000n;
  const frac = BigInt(amount) % 10_000_000n;
  return Number(`${whole}.${frac.toString().padStart(7, "0")}`).toLocaleString("en-US", {
    maximumFractionDigits: 7,
    minimumFractionDigits: 2,
  });
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export async function generateMetadata({ params }: SchedulePageProps): Promise<Metadata> {
  const { id } = await params;
  const scheduleId = parseInt(id, 10);

  if (isNaN(scheduleId)) {
    return {
      title: "Invalid Schedule - VestFlow",
      description: "The schedule ID is invalid.",
    };
  }

  try {
    const schedule = await getSchedule(scheduleId);
    if (!schedule) {
      return {
        title: "Schedule Not Found - VestFlow",
        description: "This vesting schedule could not be found.",
      };
    }

    const endTime = schedule.start_time + schedule.duration;
    const kindLabel = schedule.kind === "LinearWithCliff" ? "Linear with Cliff" : schedule.kind;
    const amount = formatAmount(schedule.total_amount.toString());
    const endDate = formatDate(endTime);
    const networkLabel = NETWORK === "mainnet" ? "Stellar Mainnet" : "Stellar Testnet";

    const title = `Vesting Schedule #${schedule.id} - ${kindLabel} - VestFlow`;
    const description = `${amount} XLM ${kindLabel} vesting schedule on ${networkLabel}. Ends ${endDate}. Grantor: ${schedule.grantor.slice(0, 8)}...${schedule.grantor.slice(-4)}.`;

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: "website",
        siteName: "VestFlow",
        images: [
          {
            url: "/og/schedule",
            width: 1200,
            height: 630,
            alt: `Vesting Schedule #${schedule.id}`,
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
      },
    };
  } catch {
    return {
      title: "Vesting Schedule - VestFlow",
      description: "View vesting schedule details on VestFlow.",
    };
  }
}

export default async function PublicSchedulePage({ params }: SchedulePageProps) {
  const { id } = await params;
  const scheduleId = parseInt(id, 10);

  if (isNaN(scheduleId)) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="card p-8 text-center border-red-500/20">
          <p className="text-red-400 font-semibold mb-4">Invalid schedule ID</p>
        </div>
      </main>
    );
  }

  const schedule = await getSchedule(scheduleId);

  if (!schedule) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="card p-8 text-center border-red-500/20">
          <p className="text-red-400 font-semibold mb-4">Schedule not found</p>
        </div>
      </main>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const { getClaimableAt } = await import("@/lib/stellar");
  const claimable = await getClaimableAt(scheduleId, now);

  return (
    <ScheduleView
      schedule={{
        ...schedule,
        total_amount: schedule.total_amount.toString(),
        claimed: schedule.claimed.toString(),
      }}
      claimable={claimable.toString()}
    />
  );
}
