import { Pool } from "pg";

interface DeliveryInput {
  campaignId: string;
  recipientEmail: string;
  senderAccount: string;
  subject: string;
  status: "sent" | "rejected";
  gmailMessageId?: string;
  gmailThreadId?: string;
  error?: string;
}

interface RejectionInput {
  campaignId: string;
  deliveryId?: number;
  recipientEmail: string;
  senderAccount: string;
  kind: "gmail_api" | "mailer_daemon";
  reason: string;
  bounceMessageId?: string;
}

export interface RejectedRecipient {
  recipientEmail: string;
  senderAccount: string;
  kind: "gmail_api" | "mailer_daemon";
  reason: string;
  detectedAt: string;
}

export interface RejectedCampaign {
  id: string;
  name: string;
  fromName: string | null;
  createdAt: string;
  rejections: RejectedRecipient[];
}

const globalWithDb = globalThis as typeof globalThis & {
  __gmailerDbPool?: Pool;
  __gmailerDbSchema?: Promise<void>;
};

function getPool(): Pool {
  if (globalWithDb.__gmailerDbPool) return globalWithDb.__gmailerDbPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }
  globalWithDb.__gmailerDbPool = new Pool({ connectionString });
  return globalWithDb.__gmailerDbPool;
}

async function ensureSchema(): Promise<void> {
  if (globalWithDb.__gmailerDbSchema) return globalWithDb.__gmailerDbSchema;
  const pool = getPool();
  globalWithDb.__gmailerDbSchema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        from_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS campaign_deliveries (
        id BIGSERIAL PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_email TEXT NOT NULL,
        sender_account TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'rejected', 'bounced')),
        gmail_message_id TEXT,
        gmail_thread_id TEXT,
        error TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS campaign_deliveries_sender_recipient_idx
        ON campaign_deliveries (sender_account, recipient_email, sent_at DESC);
      CREATE TABLE IF NOT EXISTS campaign_rejections (
        id BIGSERIAL PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        delivery_id BIGINT REFERENCES campaign_deliveries(id) ON DELETE SET NULL,
        recipient_email TEXT NOT NULL,
        sender_account TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('gmail_api', 'mailer_daemon')),
        reason TEXT NOT NULL,
        bounce_message_id TEXT,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS campaign_rejections_campaign_idx
        ON campaign_rejections (campaign_id, detected_at DESC);
      CREATE TABLE IF NOT EXISTS processed_bounces (
        sender_account TEXT NOT NULL,
        gmail_message_id TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (sender_account, gmail_message_id)
      );
    `);
  })();
  return globalWithDb.__gmailerDbSchema;
}

async function db(): Promise<Pool> {
  await ensureSchema();
  return getPool();
}

export async function createCampaign(
  id: string,
  name: string,
  fromName: string | null,
): Promise<void> {
  const pool = await db();
  await pool.query(
    `INSERT INTO campaigns (id, name, from_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, name, fromName],
  );
}

export async function recordCampaignDelivery(input: DeliveryInput): Promise<number> {
  const pool = await db();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO campaign_deliveries
       (campaign_id, recipient_email, sender_account, subject, status, gmail_message_id, gmail_thread_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.campaignId,
      input.recipientEmail,
      input.senderAccount,
      input.subject,
      input.status,
      input.gmailMessageId ?? null,
      input.gmailThreadId ?? null,
      input.error ?? null,
    ],
  );
  return Number(result.rows[0].id);
}

export async function recordRejection(input: RejectionInput): Promise<void> {
  const pool = await db();
  await pool.query(
    `INSERT INTO campaign_rejections
       (campaign_id, delivery_id, recipient_email, sender_account, kind, reason, bounce_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.campaignId,
      input.deliveryId ?? null,
      input.recipientEmail,
      input.senderAccount,
      input.kind,
      input.reason,
      input.bounceMessageId ?? null,
    ],
  );
}

export async function claimBounceForProcessing(
  senderAccount: string,
  bounceMessageId: string,
): Promise<boolean> {
  const pool = await db();
  const result = await pool.query(
    `INSERT INTO processed_bounces (sender_account, gmail_message_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING gmail_message_id`,
    [senderAccount, bounceMessageId],
  );
  return result.rowCount !== 0;
}

export async function recordMailerDaemonBounce(
  senderAccount: string,
  bounceMessageId: string,
  recipientEmail: string,
  reason: string,
): Promise<boolean> {
  const pool = await db();
  const delivery = await pool.query<{
    id: string;
    campaign_id: string;
  }>(
    `SELECT id, campaign_id
     FROM campaign_deliveries
     WHERE sender_account = $1
       AND LOWER(recipient_email) = LOWER($2)
       AND status = 'sent'
     ORDER BY sent_at DESC
     LIMIT 1`,
    [senderAccount, recipientEmail],
  );
  if (delivery.rowCount === 0) return false;
  const matched = delivery.rows[0];
  await pool.query(
    `UPDATE campaign_deliveries
     SET status = 'bounced', error = $2
     WHERE id = $1`,
    [matched.id, reason],
  );
  await pool.query(
    `INSERT INTO campaign_rejections
       (campaign_id, delivery_id, recipient_email, sender_account, kind, reason, bounce_message_id)
     VALUES ($1, $2, $3, $4, 'mailer_daemon', $5, $6)`,
    [
      matched.campaign_id,
      matched.id,
      recipientEmail,
      senderAccount,
      reason,
      bounceMessageId,
    ],
  );
  return true;
}

export async function listRejectedCampaigns(): Promise<RejectedCampaign[]> {
  const pool = await db();
  const result = await pool.query<{
    campaign_id: string;
    campaign_name: string;
    from_name: string | null;
    created_at: string;
    recipient_email: string;
    sender_account: string;
    kind: "gmail_api" | "mailer_daemon";
    reason: string;
    detected_at: string;
  }>(
    `SELECT c.id AS campaign_id, c.name AS campaign_name, c.from_name, c.created_at,
            r.recipient_email, r.sender_account, r.kind, r.reason, r.detected_at
     FROM campaign_rejections r
     JOIN campaigns c ON c.id = r.campaign_id
     ORDER BY c.created_at DESC, r.detected_at DESC`,
  );
  const campaigns = new Map<string, RejectedCampaign>();
  for (const row of result.rows) {
    let campaign = campaigns.get(row.campaign_id);
    if (!campaign) {
      campaign = {
        id: row.campaign_id,
        name: row.campaign_name,
        fromName: row.from_name,
        createdAt: row.created_at,
        rejections: [],
      };
      campaigns.set(row.campaign_id, campaign);
    }
    campaign.rejections.push({
      recipientEmail: row.recipient_email,
      senderAccount: row.sender_account,
      kind: row.kind,
      reason: row.reason,
      detectedAt: row.detected_at,
    });
  }
  return [...campaigns.values()];
}

export async function listCampaignRejections(campaignId: string): Promise<RejectedRecipient[]> {
  const pool = await db();
  const result = await pool.query<{
    recipient_email: string;
    sender_account: string;
    kind: "gmail_api" | "mailer_daemon";
    reason: string;
    detected_at: string;
  }>(
    `SELECT recipient_email, sender_account, kind, reason, detected_at
     FROM campaign_rejections
     WHERE campaign_id = $1
     ORDER BY detected_at DESC`,
    [campaignId],
  );
  return result.rows.map((row) => ({
    recipientEmail: row.recipient_email,
    senderAccount: row.sender_account,
    kind: row.kind,
    reason: row.reason,
    detectedAt: row.detected_at,
  }));
}
