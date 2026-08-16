import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json(
      { success: false, message: "Job not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ success: true, job });
}
