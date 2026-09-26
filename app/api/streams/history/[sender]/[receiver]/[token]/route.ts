import { NextRequest, NextResponse } from "next/server";
import { queryStreamHistory } from "@/indexer/src/db";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sender: string; receiver: string; token: string }> },
): Promise<NextResponse> {
  const { sender, receiver, token } = await params;
  if (!STELLAR_ADDRESS_RE.test(sender) || !STELLAR_ADDRESS_RE.test(receiver)) {
    return NextResponse.json({ error: "Invalid Stellar address" }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  const network = request.nextUrl.searchParams.get("network") ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    return NextResponse.json(
      { error: "network must be mainnet or testnet" },
      { status: 400 },
    );
  }

  const rawLimit = request.nextUrl.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return NextResponse.json(
        { error: "limit must be a positive integer no greater than 200" },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  const page = queryStreamHistory({
    sender,
    receiver,
    token,
    limit,
    cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
    network,
  });
  if (page === "not_found") {
    return NextResponse.json({ error: "Stream history not found" }, { status: 404 });
  }
  if (page === null) {
    return NextResponse.json({ error: "cursor is invalid" }, { status: 400 });
  }
  return NextResponse.json({ history: page.items, next_cursor: page.nextCursor });
}
