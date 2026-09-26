"use client";
import NewStreamClient from "./NewStreamClient";

interface StreamsNewPageProps {
  /**
   * `?beneficiary=<address>` — set by the profile "Fund this project" button
   * (#812) so the Stream Setup form opens with the receiver already filled in.
   */
  searchParams: Promise<{ beneficiary?: string | string[] }>;
}

export default async function StreamsNewPage({ searchParams }: StreamsNewPageProps) {
  const { beneficiary } = await searchParams;
  // A repeated query parameter arrives as an array; take the first entry.
  const initialBeneficiary = Array.isArray(beneficiary) ? beneficiary[0] : beneficiary;

  return <NewStreamClient initialBeneficiary={initialBeneficiary} />;
}
