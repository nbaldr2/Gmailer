import { NextResponse } from "next/server";
import { deleteAccount, listAccounts } from "@/lib/gmail";
import {
  AccountAuthError,
  AccountCooldown,
  getAccountAuthErrors,
  getAccountCooldowns,
} from "@/lib/rejections-db";

export async function GET() {
  try {
    const accounts = listAccounts();
    let cooldowns: Record<string, AccountCooldown> = {};
    let authErrors: Record<string, AccountAuthError> = {};
    try {
      const emails = accounts.map((account) => account.email);
      [cooldowns, authErrors] = await Promise.all([
        getAccountCooldowns(emails),
        getAccountAuthErrors(emails),
      ]);
    } catch (e) {
      console.error("Unable to load account cooldowns:", e);
    }
    return NextResponse.json({
      success: true,
      accounts: accounts.map((account) => ({
        ...account,
        cooldown: cooldowns[account.email] ?? null,
        authError: authErrors[account.email] ?? null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const email = (url.searchParams.get("email") ?? "").trim();
    if (!email) {
      return NextResponse.json(
        { success: false, message: "Email is required" },
        { status: 400 },
      );
    }
    deleteAccount(email);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}
