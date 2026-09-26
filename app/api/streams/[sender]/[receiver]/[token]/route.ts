import { NextRequest, NextResponse } from "next/server";
import { queryStreamConfig } from "@/indexer/src/db";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sender: string; receiver: string; token: string }> }
): Promise<NextResponse> {
  try {
    const { sender, receiver, token } = await params;

    if (!STELLAR_ADDRESS_RE.test(sender) || !STELLAR_ADDRESS_RE.test(receiver)) {
      return NextResponse.json(
        { error: "Invalid Stellar address format" },
        { status: 400 }
      );
    }

    const config = queryStreamConfig(sender, receiver, token);
    if (!config) {
      return NextResponse.json(
        { error: "No stream configured between sender and receiver" },
        { status: 404 }
      );
    }

    return NextResponse.json(config, {
      headers: { "Cache-Control": "public, max-age=10" },
    });
  } catch (error) {
    console.error("Error in GET /streams/:sender/:receiver/:token:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
