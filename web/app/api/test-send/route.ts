import { NextResponse } from "next/server";
import { sendOne } from "@/lib/gmail";
import {
  clearAccountAuthError,
  clearAccountCooldown,
  isOAuthInvalidGrantError,
  setAccountAuthError,
} from "@/lib/rejections-db";

export async function POST(request: Request) {
  let account = "";
  try {
    const body = await request.json();
    account = String(body.account ?? "").trim();
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
    try {
      await clearAccountCooldown(account);
      await clearAccountAuthError(account);
    } catch (e) {
      console.error("Unable to clear account cooldown after test send:", e);
    }
    return NextResponse.json({
      success: true,
      messageId: res.id,
      threadId: res.threadId,
    });
  } catch (e: any) {
    if (account && isOAuthInvalidGrantError(e.message || String(e))) {
      try {
        await setAccountAuthError(account, e.message || String(e));
      } catch {}
    }
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}
