import { NextResponse } from "next/server";
import {
  createBounceScanJob,
  getBounceScanJob,
  runBounceScanJob,
} from "@/lib/bounce-scan-jobs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accounts: string[] = Array.isArray(body.accounts)
      ? body.accounts.filter((account: unknown) => typeof account === "string")
      : [];
    if (accounts.length === 0) {
      return NextResponse.json(
        { success: false, message: "No accounts selected" },
        { status: 400 },
      );
    }
    const job = createBounceScanJob(accounts);
    runBounceScanJob(job.id, accounts).catch((e) =>
      console.error("Bounce scan failed:", e),
    );
    return NextResponse.json({ success: true, job });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { success: false, message: "Scan job ID is required" },
      { status: 400 },
    );
  }
  const job = getBounceScanJob(id);
  if (!job) {
    return NextResponse.json(
      { success: false, message: "Scan job not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ success: true, job });
}
