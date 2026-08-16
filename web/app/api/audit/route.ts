import { NextResponse } from "next/server";
import { readAudit } from "@/lib/store";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      Math.max(1, Number(searchParams.get("limit")) || 100),
      2000,
    );
    const entries = readAudit(limit);
    return NextResponse.json({ success: true, entries });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}