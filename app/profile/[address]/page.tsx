import { Metadata } from "next";
import ProfileView from "./ProfileView";
import { truncate } from "@/lib/stellar";

interface ProfilePageProps {
  params: Promise<{ address: string }>;
}

export async function generateMetadata({ params }: ProfilePageProps): Promise<Metadata> {
  const { address } = await params;
  const shortAddr = truncate(address);
  return {
    title: `Profile ${shortAddr} - VestFlow`,
    description: `Public stream and vesting profile for ${address} on VestFlow.`,
  };
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { address } = await params;
  return <ProfileView address={address} />;
}
