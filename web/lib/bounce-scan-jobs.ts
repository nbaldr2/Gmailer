import {
  getMailerDaemonMessage,
  listMailerDaemonMessageIds,
} from "./gmail";
import {
  claimBounceForProcessing,
  isAccountCooldownError,
  recordAccountLevelBounce,
  recordMailerDaemonBounce,
  setAccountCooldown,
} from "./rejections-db";

export interface BounceScanAccountProgress {
  examined: number;
  imported: number;
  unmatched: number;
  error?: string;
}

export interface BounceScanJob {
  id: string;
  status: "running" | "done";
  accounts: Record<string, BounceScanAccountProgress>;
  startedAt: number;
  finishedAt?: number;
}

export interface BounceScanOptions {
  campaignId?: string;
  notBefore?: number;
}

const scanJobs = new Map<string, BounceScanJob>();

function parseRecipients(raw: string): string[] {
  const recipients = new Set<string>();
  const diagnosticFields = raw.matchAll(
    /(?:Final-Recipient|Original-Recipient|X-Failed-Recipients):[^\r\n]*?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi,
  );
  for (const match of diagnosticFields) recipients.add(match[1].toLowerCase());
  if (recipients.size > 0) return [...recipients];

  const fallback = raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  for (const match of fallback) {
    const email = match[0].toLowerCase();
    if (!email.includes("mailer-daemon") && !email.startsWith("postmaster@")) {
      recipients.add(email);
    }
  }
  return [...recipients];
}

function parseReason(raw: string): string {
  const match = raw.match(/The response was:\s*([\s\S]{1,1200})/i)
    ?? raw.match(/Diagnostic-Code:\s*[^;]+;\s*([\s\S]{1,1200})/i);
  const text = (match?.[1] ?? "Mailer-Daemon delivery failure")
    .replace(/\r?\n\r?\n[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 1200);
}

export function createBounceScanJob(accounts: string[]): BounceScanJob {
  const job: BounceScanJob = {
    id: crypto.randomUUID(),
    status: "running",
    accounts: Object.fromEntries(
      accounts.map((email) => [email, { examined: 0, imported: 0, unmatched: 0 }]),
    ),
    startedAt: Date.now(),
  };
  scanJobs.set(job.id, job);
  return job;
}

export function getBounceScanJob(id: string): BounceScanJob | undefined {
  return scanJobs.get(id);
}

export async function scanBounceAccounts(
  accounts: string[],
  progressByAccount: Record<string, BounceScanAccountProgress>,
  options: BounceScanOptions = {},
) {
  await Promise.all(accounts.map(async (account) => {
    const progress = progressByAccount[account];
    if (!progress) return;
    try {
      const messageIds = await listMailerDaemonMessageIds(account);
      for (const messageId of messageIds) {
        progress.examined++;
        const message = await getMailerDaemonMessage(account, messageId);
        if (options.notBefore && message.receivedAt < options.notBefore) continue;
        const recipients = parseRecipients(message.raw);
        const reason = parseReason(message.raw);
        const newlyClaimed = await claimBounceForProcessing(account, messageId);
        if (isAccountCooldownError(reason)) {
          try {
            await setAccountCooldown(account, reason);
          } catch (dbError) {
            console.error("Unable to set account cooldown:", dbError);
          }
          if (recipients.length === 0) {
            if (await recordAccountLevelBounce({
              campaignId: options.campaignId,
              senderAccount: account,
              bounceMessageId: message.id,
              reason,
            })) {
              progress.imported++;
            } else {
              progress.unmatched++;
            }
            continue;
          }
        }
        if (!newlyClaimed) continue;
        if (recipients.length === 0) {
          progress.unmatched++;
          continue;
        }
        for (const recipient of recipients) {
          if (await recordMailerDaemonBounce(account, message.id, recipient, reason)) {
            progress.imported++;
          } else {
            progress.unmatched++;
          }
        }
      }
    } catch (e: any) {
      progress.error = e.message || String(e);
    }
  }));
}

export async function runBounceScanJob(jobId: string, accounts: string[]) {
  const job = scanJobs.get(jobId);
  if (!job) return;

  await scanBounceAccounts(accounts, job.accounts);

  job.status = "done";
  job.finishedAt = Date.now();
}
