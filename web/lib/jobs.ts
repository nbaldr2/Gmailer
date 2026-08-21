import { createGmailService, sendWithService } from "./gmail";
import { RecipientRow, resolveTemplate } from "./template";
import { appendAudit } from "./store";
import {
  isAccountCooldownError,
  getAccountCooldowns,
  recordAccountCooldownRejections,
  recordCampaignDelivery,
  recordRejection,
  setAccountCooldown,
} from "./rejections-db";

export interface JobLog {
  ts: number;
  account: string;
  message: string;
  kind: "ok" | "fail" | "info";
}

export interface JobState {
  id: string;
  campaign: string;
  status: "running" | "done";
  total: number;
  skipped: number;
  sent: number;
  failed: number;
  startedAt: number;
  finishedAt: number | null;
  perAccount: Record<
    string,
    { done: number; sent: number; failed: number }
  >;
  cooldownAccounts: Record<string, { cooldownUntil: number; reason: string }>;
  logs: JobLog[];
}

export interface SendSettings {
  rateLimitMs: number;
  maxPerAccount: number;
}

const globalWithJobs = globalThis as typeof globalThis & {
  __gmailJobs?: Map<string, JobState>;
};
const jobs =
  globalWithJobs.__gmailJobs ||
  (globalWithJobs.__gmailJobs = new Map<string, JobState>());

function nextId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function pushLog(jobId: string, log: JobLog) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.logs.push(log);
  if (job.logs.length > 300) {
    job.logs = job.logs.slice(-300);
  }
}

function cleanupOldJobs() {
  const cutoff = Date.now() - 3600_000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

export function createJob(
  total: number,
  skipped: number,
  accounts: string[],
  campaign: string,
): string {
  const id = nextId();
  const perAccount: JobState["perAccount"] = {};
  for (const a of accounts) {
    perAccount[a] = { done: 0, sent: 0, failed: 0 };
  }
  jobs.set(id, {
    id,
    campaign,
    status: "running",
    total,
    skipped,
    sent: 0,
    failed: 0,
    startedAt: Date.now(),
    finishedAt: null,
    perAccount,
    cooldownAccounts: {},
    logs: [],
  });
  cleanupOldJobs();
  return id;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

export function finishJob(id: string) {
  const job = jobs.get(id);
  if (job) {
    job.status = "done";
    job.finishedAt = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runJob(
  jobId: string,
  campaign: string,
  accounts: string[],
  recipients: RecipientRow[],
  subjects: string[],
  fromName: string | null,
  html: string,
  settings: SendSettings,
) {
  const n = accounts.length;
  const chunks = accounts.map((_, i) =>
    recipients.filter((_, idx) => idx % n === i),
  );

  const stopAccountForCooldown = async (
    account: string,
    chunk: RecipientRow[],
    startIndex: number,
    reason: string,
    cooldownUntil = Date.now() + 24 * 60 * 60 * 1000,
  ) => {
    const remaining = chunk.slice(startIndex).map((recipient) => ({
      email: recipient.email,
      subject: resolveTemplate(
        subjects[Math.floor(Math.random() * subjects.length)],
        recipient,
      ),
    }));
    const job = jobs.get(jobId);
    if (job) {
      job.cooldownAccounts[account] = { cooldownUntil, reason };
    }
    if (remaining.length > 0) {
      try {
        await recordAccountCooldownRejections({
          campaignId: jobId,
          senderAccount: account,
          recipients: remaining,
          reason: `Sender account cooldown: ${reason}`,
        });
      } catch (dbError) {
        console.error("Unable to save cooldown rejections:", dbError);
      }
      if (job) {
        job.failed += remaining.length;
        job.perAccount[account].failed += remaining.length;
        job.perAccount[account].done += remaining.length;
      }
    }
    pushLog(jobId, {
      ts: Date.now(),
      account,
      message: `Account entered a 24-hour cooldown. ${remaining.length} remaining recipient(s) saved as rejected.`,
      kind: "info",
    });
  };

  const workers = accounts.map(async (account, i) => {
    const chunk = chunks[i];
    if (chunk.length === 0) return;
    const gmail = createGmailService(account);
    pushLog(jobId, {
      ts: Date.now(),
      account,
      message: `Worker started with ${chunk.length} recipient(s)`,
      kind: "info",
    });
    let lastSentAt = 0;
    for (let j = 0; j < chunk.length; j++) {
      if (settings.maxPerAccount > 0 && j >= settings.maxPerAccount) {
        pushLog(jobId, {
          ts: Date.now(),
          account,
          message: `Quota reached (${settings.maxPerAccount} per account), stopping`,
          kind: "info",
        });
        break;
      }
      const recipient = chunk[j];
      const wait = settings.rateLimitMs - (Date.now() - lastSentAt);
      if (wait > 0) await sleep(wait);
      lastSentAt = Date.now();
      try {
        const cooldown = (await getAccountCooldowns([account]))[account];
        if (cooldown) {
          await stopAccountForCooldown(
            account,
            chunk,
            j,
            cooldown.reason,
            Date.parse(cooldown.cooldownUntil),
          );
          break;
        }
      } catch (dbError) {
        console.error("Unable to check account cooldown:", dbError);
      }
      const subject = subjects[Math.floor(Math.random() * subjects.length)];
      const resolvedSubject = resolveTemplate(subject, recipient);
      const resolvedHtml = resolveTemplate(html, recipient);
      try {
        const res = await sendWithService(
          gmail,
          account,
          recipient.email,
          resolvedSubject,
          fromName,
          resolvedHtml,
        );
        const job = jobs.get(jobId);
        if (job) {
          job.sent++;
          job.perAccount[account].sent++;
          job.perAccount[account].done++;
        }
        appendAudit({
          ts: new Date().toISOString(),
          campaign,
          recipient: recipient.email,
          account,
          status: "sent",
          messageId: res.id as string,
          threadId: res.threadId as string,
        });
        try {
          await recordCampaignDelivery({
            campaignId: jobId,
            recipientEmail: recipient.email,
            senderAccount: account,
            subject: resolvedSubject,
            status: "sent",
            gmailMessageId: res.id as string,
            gmailThreadId: res.threadId as string,
          });
        } catch (dbError) {
          console.error("Unable to record sent delivery:", dbError);
        }
        pushLog(jobId, {
          ts: Date.now(),
          account,
          message: `Sent to ${recipient.email} (${resolvedSubject})`,
          kind: "ok",
        });
      } catch (e: any) {
        const failureReason = e.message || String(e);
        const job = jobs.get(jobId);
        if (job) {
          job.failed++;
          job.perAccount[account].failed++;
          job.perAccount[account].done++;
        }
        appendAudit({
          ts: new Date().toISOString(),
          campaign,
          recipient: recipient.email,
          account,
          status: "failed",
          error: failureReason,
        });
        try {
          const deliveryId = await recordCampaignDelivery({
            campaignId: jobId,
            recipientEmail: recipient.email,
            senderAccount: account,
            subject: resolvedSubject,
            status: "rejected",
            error: failureReason,
          });
          await recordRejection({
            campaignId: jobId,
            deliveryId,
            recipientEmail: recipient.email,
            senderAccount: account,
            kind: "gmail_api",
            reason: failureReason,
          });
        } catch (dbError) {
          console.error("Unable to record rejected delivery:", dbError);
        }
        pushLog(jobId, {
          ts: Date.now(),
          account,
          message: `FAILED ${recipient.email}: ${failureReason}`,
          kind: "fail",
        });
        if (isAccountCooldownError(failureReason)) {
          const cooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
          try {
            await setAccountCooldown(account, failureReason);
          } catch (dbError) {
            console.error("Unable to set account cooldown:", dbError);
          }
          await stopAccountForCooldown(
            account,
            chunk,
            j + 1,
            failureReason,
            cooldownUntil,
          );
          break;
        }
      }
    }
  });

  await Promise.all(workers);
  finishJob(jobId);
}
