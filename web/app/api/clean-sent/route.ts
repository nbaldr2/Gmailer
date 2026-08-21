import { NextResponse } from "next/server";
import {
  CleanTarget,
  createCleanJob,
  getCleanJob,
  runCleanJob,
} from "@/lib/clean-jobs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accounts: string[] = Array.isArray(body.accounts)
      ? body.accounts.filter((a: unknown) => typeof a === "string")
      : [];
    const target: CleanTarget = body.target === "trash" ? "trash" : "sent";
    if (accounts.length === 0) {
      return NextResponse.json(
        { success: false, message: "No accounts selected" },
        { status: 400 },
      );
    }

    const job = createCleanJob(accounts, target);
    runCleanJob(job.id, accounts).catch((e) =>
      console.error(`${target} cleanup job failed:`, e),
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
      { success: false, message: "Job ID is required" },
      { status: 400 },
    );
  }
  const job = getCleanJob(id);
  if (!job) {
    return NextResponse.json(
      { success: false, message: "Clean job not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ success: true, job });
}
