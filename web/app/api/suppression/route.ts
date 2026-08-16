import { NextResponse } from "next/server";
import { getSuppressionList, setSuppressionList } from "@/lib/store";

export async function GET() {
  try {
    const list = getSuppressionList();
    return NextResponse.json({ success: true, emails: list });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const emails: string[] = Array.isArray(body.emails)
      ? body.emails.map((e: unknown) => String(e).trim()).filter(Boolean)
      : [];
    setSuppressionList(emails);
    return NextResponse.json({ success: true, count: emails.length });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}