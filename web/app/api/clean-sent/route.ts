import { NextResponse } from "next/server";
import { listSentMessages, trashMessage } from "@/lib/gmail";

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accounts: string[] = Array.isArray(body.accounts)
      ? body.accounts.filter((a: unknown) => typeof a === "string")
      : [];
    const maxResults =
      typeof body.maxResults === "number" && body.maxResults > 0
        ? Math.min(body.maxResults, 10000)
        : 500;

    if (accounts.length === 0) {
      return NextResponse.json(
        { success: false, message: "No accounts selected" },
        { status: 400 },
      );
    }

    const results: Record<
      string,
      { total: number; deleted: number; error?: string }
    > = {};

    for (const email of accounts) {
      try {
        const ids = await listSentMessages(email, maxResults);
        results[email] = { total: ids.length, deleted: 0 };
        for (const id of ids) {
          await randomDelay(500, 1500);
          try {
            await trashMessage(email, id);
            results[email].deleted++;
          } catch {
            // skip individual failures, continue with next
          }
        }
      } catch (e: any) {
        results[email] = { total: 0, deleted: 0, error: e.message || String(e) };
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}