import { google } from "googleapis";
import fs from "fs";
import path from "path";

export const TOKEN_DIR =
  process.env.TOKEN_DIR ||
  path.resolve(process.cwd(), "..", "token_files");

export const PROJECT_ROOT = path.resolve(TOKEN_DIR, "..");

export interface GmailAccount {
  email: string;
}

export function listAccounts(): GmailAccount[] {
  if (!fs.existsSync(TOKEN_DIR)) return [];
  return fs
    .readdirSync(TOKEN_DIR)
    .filter(
      (f) => f.startsWith("token_gmail_v1_") && f.endsWith(".json"),
    )
    .map((f) => ({
      email: f.replace("token_gmail_v1_", "").replace(".json", ""),
    }))
    .sort();
}

export function deleteAccount(email: string): void {
  if (!/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(email)) {
    throw new Error("Invalid email address");
  }
  const tokenFile = path.join(
    TOKEN_DIR,
    `token_gmail_v1_${email}.json`,
  );
  if (!fs.existsSync(tokenFile)) {
    throw new Error(`Token file not found for ${email}`);
  }
  fs.unlinkSync(tokenFile);
}

function getClient(email: string) {
  const tokenFile = path.join(
    TOKEN_DIR,
    `token_gmail_v1_${email}.json`,
  );
  if (!fs.existsSync(tokenFile)) {
    throw new Error(`Token file not found for ${email}`);
  }
  const data = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const oauth = new google.auth.OAuth2(
    data.client_id,
    data.client_secret,
    data.redirect_uris?.[0] || "http://localhost",
  );
  oauth.setCredentials({
    refresh_token: data.refresh_token,
    expiry_date: data.expiry ? Date.parse(data.expiry) : undefined,
  });
  return oauth;
}

function buildMime(
  fromEmail: string,
  to: string,
  subject: string,
  fromName: string | null,
  html: string,
) {
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const boundary =
    `----=_Part_${Date.now().toString(36)}_` +
    Math.random().toString(36).slice(2, 8);
  const plain = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
  ].join("\r\n");
  const alt =
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
    `${plain}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
    `${html}\r\n` +
    `--${boundary}--\r\n`;
  return Buffer.from(head + alt, "utf8").toString("base64url");
}

export async function sendOne(
  email: string,
  recipient: string,
  subject: string,
  fromName: string | null,
  html: string,
) {
  const auth = getClient(email);
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildMime(email, recipient, subject, fromName, html);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return res.data;
}

export function createGmailService(email: string) {
  const auth = getClient(email);
  return google.gmail({ version: "v1", auth });
}

export async function sendWithService(
  gmail: ReturnType<typeof createGmailService>,
  email: string,
  recipient: string,
  subject: string,
  fromName: string | null,
  html: string,
) {
  const raw = buildMime(email, recipient, subject, fromName, html);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return res.data;
}