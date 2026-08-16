import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./gmail";

export const DATA_DIR = path.join(PROJECT_ROOT, "data");

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getSuppressionList(): string[] {
  ensureDataDir();
  const file = path.join(DATA_DIR, "suppression.txt");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function setSuppressionList(emails: string[]) {
  ensureDataDir();
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  fs.writeFileSync(
    path.join(DATA_DIR, "suppression.txt"),
    unique.join("\n") + "\n",
  );
}

export interface AuditEntry {
  ts: string;
  campaign: string;
  recipient: string;
  account: string;
  status: "sent" | "failed";
  messageId?: string;
  threadId?: string;
  error?: string;
}

export function appendAudit(entry: AuditEntry) {
  ensureDataDir();
  fs.appendFileSync(
    path.join(DATA_DIR, "audit.jsonl"),
    JSON.stringify(entry) + "\n",
  );
}

export function readAudit(limit = 100): AuditEntry[] {
  ensureDataDir();
  const file = path.join(DATA_DIR, "audit.jsonl");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as AuditEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is AuditEntry => e !== null)
    .reverse();
}
