import {
  deleteMessage,
  listSentMessages,
  listTrashMessages,
  trashMessage,
} from "./gmail";

export type CleanTarget = "sent" | "trash";

export interface CleanAccountProgress {
  total: number;
  deleted: number;
  failed: number;
  error?: string;
}

export interface CleanJob {
  id: string;
  status: "running" | "done";
  target: CleanTarget;
  accounts: Record<string, CleanAccountProgress>;
  startedAt: number;
  finishedAt?: number;
}

const cleanJobs = new Map<string, CleanJob>();

function pause(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCleanJob(accounts: string[], target: CleanTarget): CleanJob {
  const job: CleanJob = {
    id: crypto.randomUUID(),
    status: "running",
    target,
    accounts: Object.fromEntries(
      accounts.map((email) => [email, { total: 0, deleted: 0, failed: 0 }]),
    ),
    startedAt: Date.now(),
  };
  cleanJobs.set(job.id, job);
  return job;
}

export function getCleanJob(id: string): CleanJob | undefined {
  return cleanJobs.get(id);
}

export async function runCleanJob(jobId: string, accounts: string[]) {
  const job = cleanJobs.get(jobId);
  if (!job) return;

  for (const email of accounts) {
    const progress = job.accounts[email];
    try {
      const ids = job.target === "trash"
        ? await listTrashMessages(email, Number.MAX_SAFE_INTEGER)
        : await listSentMessages(email, Number.MAX_SAFE_INTEGER);
      progress.total = ids.length;
      for (const id of ids) {
        await pause(500, 1500);
        try {
          if (job.target === "trash") await deleteMessage(email, id);
          else await trashMessage(email, id);
          progress.deleted++;
        } catch {
          progress.failed++;
        }
      }
    } catch (e: any) {
      progress.error = e.message || String(e);
    }
  }

  job.status = "done";
  job.finishedAt = Date.now();
}
