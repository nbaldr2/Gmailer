import { NextResponse } from "next/server";
import { deleteAccount, listAccounts } from "@/lib/gmail";

export async function GET() {
  try {
    const accounts = listAccounts();
    return NextResponse.json({ success: true, accounts });
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
