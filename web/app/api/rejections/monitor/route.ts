import { NextResponse } from "next/server";
import { getRejectionMonitors } from "@/lib/rejection-monitor";

export async function GET() {
  return NextResponse.json({ success: true, monitors: getRejectionMonitors() });
}
