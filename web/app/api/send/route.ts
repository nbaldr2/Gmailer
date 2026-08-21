import { NextResponse } from "next/server";
import { createJob, runJob, SendSettings } from "@/lib/jobs";
import { RecipientRow, validateEmail } from "@/lib/template";
import { getSuppressionList } from "@/lib/store";
import { createCampaign, getAccountCooldowns } from "@/lib/rejections-db";

const DEFAULT_SETTINGS: SendSettings = {
  rateLimitMs: 1000,
  maxPerAccount: 500,
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accounts: string[] = Array.isArray(body.accounts)
      ? body.accounts.filter((a: unknown) => typeof a === "string")
      : [];
    const rawRecipients: Array<{ email: string; [k: string]: string }> =
      Array.isArray(body.recipients) ? body.recipients : [];
    const rawSubjects: string[] = Array.isArray(body.subjects)
      ? body.subjects.map((s: unknown) => String(s).trim()).filter(Boolean)
      : body.subject
        ? [String(body.subject).trim()]
        : [];
    const fromName = body.fromName
      ? String(body.fromName).trim()
      : null;
    const html = String(body.html ?? "");
    const campaign = String(body.campaign ?? `Campaign ${new Date().toISOString().slice(0, 10)}`).trim();

    const settings: SendSettings = {
      rateLimitMs:
        typeof body.rateLimitMs === "number" && body.rateLimitMs >= 100
          ? body.rateLimitMs
          : DEFAULT_SETTINGS.rateLimitMs,
      maxPerAccount:
        typeof body.maxPerAccount === "number" && body.maxPerAccount >= 1
          ? body.maxPerAccount
          : DEFAULT_SETTINGS.maxPerAccount,
    };

    if (accounts.length === 0) {
      return NextResponse.json(
        { success: false, message: "No accounts selected" },
        { status: 400 },
      );
    }
    const cooldowns = await getAccountCooldowns(accounts);
    const activeAccounts = accounts.filter((account) => !cooldowns[account]);
    if (activeAccounts.length === 0) {
      return NextResponse.json(
        {
          success: false,
          message: "All selected accounts are in a 24-hour sending cooldown.",
          cooldowns,
        },
        { status: 429 },
      );
    }
    if (rawRecipients.length === 0) {
      return NextResponse.json(
        { success: false, message: "No recipients provided" },
        { status: 400 },
      );
    }
    if (rawSubjects.length === 0) {
      return NextResponse.json(
        { success: false, message: "Subject is required" },
        { status: 400 },
      );
    }
    if (!html.trim()) {
      return NextResponse.json(
        { success: false, message: "Body is required" },
        { status: 400 },
      );
    }

    const recipients: RecipientRow[] = [];
    const invalid: string[] = [];
    for (const r of rawRecipients) {
      const email = String(r.email ?? "").trim();
      if (!validateEmail(email)) {
        invalid.push(email || "(empty)");
        continue;
      }
      recipients.push({ ...r, email });
    }

    const suppression = new Set(getSuppressionList());
    const suppressed: string[] = [];
    const filtered = recipients.filter((r) => {
      if (suppression.has(r.email.toLowerCase())) {
        suppressed.push(r.email);
        return false;
      }
      return true;
    });

    const total = rawRecipients.length;
    const skipped = total - filtered.length;

    if (filtered.length === 0) {
      return NextResponse.json({
        success: false,
        message: `All ${total} recipients are invalid or suppressed`,
        stats: { total, invalid: invalid.length, suppressed: suppressed.length, ready: 0 },
      });
    }

    const jobId = createJob(filtered.length, skipped, activeAccounts, campaign);
    await createCampaign(jobId, campaign, fromName);
    runJob(
      jobId,
      campaign,
      activeAccounts,
      filtered,
      rawSubjects,
      fromName,
      html,
      settings,
    ).catch((e) => console.error("Job failed:", e));

    return NextResponse.json({
      success: true,
      jobId,
      stats: {
        total,
        invalid: invalid.length,
        suppressed: suppressed.length,
        ready: filtered.length,
        cooledDownAccounts: accounts.length - activeAccounts.length,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}
