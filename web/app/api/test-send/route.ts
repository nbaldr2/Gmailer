import { NextResponse } from "next/server";
import { sendOne } from "@/lib/gmail";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const account = String(body.account ?? "").trim();
    const to = String(body.to ?? "").trim();
    const subject = String(body.subject ?? "").trim();
    const fromName = body.fromName ? String(body.fromName).trim() : null;
    const html = String(body.html ?? "").trim();

    if (!account || !to || !subject || !html) {
      return NextResponse.json(
        { success: false, message: "account, to, subject, and html are required" },
        { status: 400 },
      );
    }

    const res = await sendOne(account, to, subject, fromName, html);
    return NextResponse.json({
      success: true,
      messageId: res.id,
      threadId: res.threadId,
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}