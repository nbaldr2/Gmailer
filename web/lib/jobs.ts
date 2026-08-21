import { createGmailService, listAccounts, sendWithService } from "./gmail";
import { RecipientRow, resolveTemplate } from "./template";
import { appendAudit } from "./store";
import { recordCampaignDelivery, recordRejection } from "./rejections-db";
import { startRejectionMonitor } from "./rejection-monitor";

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
          error: e.message || String(e),
        });
        try {
          const deliveryId = await recordCampaignDelivery({
            campaignId: jobId,
            recipientEmail: recipient.email,
            senderAccount: account,
            subject: resolvedSubject,
            status: "rejected",
            error: e.message || String(e),
          });
          await recordRejection({
            campaignId: jobId,
            deliveryId,
            recipientEmail: recipient.email,
            senderAccount: account,
            kind: "gmail_api",
            reason: e.message || String(e),
          });
        } catch (dbError) {
          console.error("Unable to record rejected delivery:", dbError);
        }
        pushLog(jobId, {
          ts: Date.now(),
          account,
          message: `FAILED ${recipient.email}: ${e.message || String(e)}`,
          kind: "fail",
        });
      }
    }
  });

  await Promise.all(workers);
  finishJob(jobId);
  startRejectionMonitor(jobId, listAccounts().map((account) => account.email));
}
