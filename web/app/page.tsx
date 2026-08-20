"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveTemplate, RecipientRow, validateEmail } from "@/lib/template";

type Tab = "compose" | "recipients" | "settings" | "logs" | "clean";

interface JobPerAccount {
  done: number;
  sent: number;
  failed: number;
}
interface JobLog {
  ts: number;
  account: string;
  message: string;
  kind: "ok" | "fail" | "info";
}
interface Job {
  id: string;
  campaign: string;
  status: "running" | "done";
  total: number;
  skipped: number;
  sent: number;
  failed: number;
  startedAt: number;
  finishedAt: number | null;
  perAccount: Record<string, JobPerAccount>;
  logs: JobLog[];
}

interface AuditEntry {
  ts: string;
  campaign: string;
  recipient: string;
  account: string;
  status: "sent" | "failed";
  messageId?: string;
  threadId?: string;
  error?: string;
}

interface SendStats {
  total: number;
  invalid: number;
  suppressed: number;
  ready: number;
}

const SAMPLE: RecipientRow = {
  email: "john.doe@example.com",
  firstname: "John",
  lastname: "Doe",
  fullname: "John Doe",
  company: "Acme Inc",
  jobtitle: "Manager",
  phone: "+1 555 1234",
  address: "123 Main St",
  city: "Springfield",
  country: "US",
  domain: "acme.com",
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    } else cur += ch;
  }
  row.push(cur);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

function csvToRecipients(text: string): RecipientRow[] | null {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = header.indexOf("email");
  if (emailIdx === -1) return null;
  const FIELDS = [
    "email","firstname","lastname","fullname","company","jobtitle",
    "phone","address","city","country","domain",
  ];
  return rows.slice(1).map((r) => {
    const rec: RecipientRow = { email: (r[emailIdx] ?? "").trim() };
    for (const f of FIELDS) {
      const idx = header.indexOf(f);
      if (idx >= 0 && r[idx]?.trim()) rec[f] = r[idx].trim();
    }
    return rec;
  }).filter((r) => r.email);
}

function recipientsToText(recipients: RecipientRow[]): string {
  return recipients.map((r) => r.email).join("\n");
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("compose");
  const [accounts, setAccounts] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [recipientsText, setRecipientsText] = useState("");
  const [subject, setSubject] = useState("");
  const [fromName, setFromName] = useState("");
  const [body, setBody] = useState("");
  const [campaign, setCampaign] = useState(
    `Campaign ${new Date().toISOString().slice(0, 10)}`,
  );
  const [rateLimitMs, setRateLimitMs] = useState(1000);
  const [maxPerAccount, setMaxPerAccount] = useState(500);
  const [suppression, setSuppression] = useState("");
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<SendStats | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testAcc, setTestAcc] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [invalidEmails, setInvalidEmails] = useState<string[]>([]);
  const [copiedVar, setCopiedVar] = useState<string>("");
  const [cleaning, setCleaning] = useState(false);
  const [cleanResults, setCleanResults] = useState<
    Record<string, { total: number; deleted: number; error?: string }> | null
  >(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const copyVar = useCallback(async (v: string) => {
    try {
      await navigator.clipboard.writeText(`[-${v}-]`);
      setCopiedVar(v);
      setTimeout(() => setCopiedVar(""), 1200);
    } catch { /* clipboard not available */ }
  }, []);

  const RANDOM_VARS = [
    "randomstring", "randomnumber", "randomletters", "randomdS",
    "randomuuid", "randomhex", "shortid", "randomcolor", "randompid", "randomu",
  ];

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d) => { if (d.success) setAccounts(d.accounts.map((a: { email: string }) => a.email)); });
    return stopPolling;
  }, [stopPolling]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const err = params.get("error");
    if (connected) {
      setError("");
      alert(`Account connected: ${connected}`);
      window.location.href = "/";
    } else if (err) {
      setError(`OAuth error: ${err}`);
    }
  }, []);

  const toggleAccount = (email: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(email) ? next.delete(email) : next.add(email);
      return next;
    });
  };
  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === accounts.length ? new Set() : new Set(accounts),
    );

  const removeAccount = async (email: string) => {
    if (!window.confirm(`Delete account ${email}? This removes its stored Gmail token and you will need to reconnect it via OAuth.`)) return;
    try {
      const res = await fetch(
        `/api/accounts?email=${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );
      const d = await res.json();
      if (!d.success) { setError(d.message); return; }
      setAccounts((prev) => prev.filter((a) => a !== email));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(email);
        return next;
      });
    } catch (e: any) { setError(e.message); }
  };

  const cleanSent = async () => {
    const accts = [...selected];
    if (accts.length === 0) { setError("Select at least one account."); return; }
    if (
      !window.confirm(
        `Move ALL sent messages to trash for:\n${accts.join("\n")}\n\nThis cannot be undone. Continue?`,
      )
    )
      return;
    setError("");
    setCleaning(true);
    setCleanResults(null);
    try {
      const res = await fetch("/api/clean-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: accts }),
      });
      const d = await res.json();
      if (!d.success) { setError(d.message); setCleaning(false); return; }
      setCleanResults(d.results);
    } catch (e: any) {
      setError(e.message);
    }
    setCleaning(false);
  };

  const loadFile = async (name: string) => {
    try {
      const res = await fetch(`/api/files/${name}`);
      const d = await res.json();
      if (!d.success) { setError(d.message); return; }
      setBody(d.content);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = csvToRecipients(reader.result as string);
      if (parsed === null) {
        setError("CSV must have an 'email' header column");
        return;
      }
      const map = new Map<string, RecipientRow>();
      for (const r of recipients) map.set(r.email.toLowerCase(), r);
      for (const r of parsed) map.set(r.email.toLowerCase(), r);
      const merged = [...map.values()];
      setRecipients(merged);
      setRecipientsText(recipientsToText(merged));
      setError("");
    };
    reader.readAsText(file);
  };

  const handleTextareaChange = (text: string) => {
    setRecipientsText(text);
    const emails = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    setRecipients((prev) => {
      const prevMap = new Map<string, RecipientRow>();
      for (const r of prev) prevMap.set(r.email.toLowerCase(), r);
      return emails.map((email) => prevMap.get(email.toLowerCase()) ?? { email });
    });
  };

  useEffect(() => {
    const invalid = recipients.filter((r) => !validateEmail(r.email)).map((r) => r.email);
    setInvalidEmails(invalid);
  }, [recipients]);

  const subjectLines = subject
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const resolvedSubjects = subjectLines.map((s) => resolveTemplate(s, SAMPLE));
  const resolvedHtml = resolveTemplate(body, SAMPLE);

  const pollJob = useCallback(
    (jobId: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/jobs/${jobId}`);
          const d = await res.json();
          if (d.success) {
            setJob(d.job);
            if (d.job.status === "done") stopPolling();
          }
        } catch { /* poll silently */ }
      }, 700);
    },
    [stopPolling],
  );

  const send = async () => {
    setError("");
    setStats(null);
    if (selected.size === 0) { setError("Select at least one account."); return; }
    const valid = recipients.filter((r) => validateEmail(r.email));
    if (!valid.length) { setError("No valid recipients."); return; }
    if (subjectLines.length === 0) { setError("Subject is required."); return; }
    if (!body.trim()) { setError("HTML body is required."); return; }
    setSending(true);
    setJob(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: [...selected],
          recipients: valid,
          subjects: subjectLines,
          fromName: fromName.trim() || null,
          html: body,
          campaign: campaign.trim(),
          rateLimitMs,
          maxPerAccount,
        }),
      });
      const d = await res.json();
      if (!d.success) {
        setError(d.message);
        if (d.stats) setStats(d.stats);
        setSending(false);
        return;
      }
      if (d.stats) setStats(d.stats);
      pollJob(d.jobId);
    } catch (e: any) {
      setError(e.message);
      setSending(false);
    }
  };

  const testSend = async () => {
    setTestStatus("");
    if (!testAcc || !testTo) { setTestStatus("Select an account and enter a test email."); return; }
    if (subjectLines.length === 0) { setTestStatus("Add at least one subject."); return; }
    setTestStatus("Sending...");
    try {
      const res = await fetch("/api/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: testAcc,
          to: testTo,
          subject: resolveTemplate(
            subjectLines[Math.floor(Math.random() * subjectLines.length)],
            { email: testTo },
          ),
          fromName: fromName.trim() || null,
          html: resolveTemplate(body, { email: testTo }),
        }),
      });
      const d = await res.json();
      setTestStatus(d.success ? `Sent (id: ${d.messageId})` : `Error: ${d.message}`);
    } catch (e: any) {
      setTestStatus(`Error: ${e.message}`);
    }
  };

  const connectAccount = async () => {
    try {
      const res = await fetch("/api/oauth/start");
      const d = await res.json();
      if (d.success) window.location.href = d.url;
      else setError(d.message);
    } catch (e: any) { setError(e.message); }
  };

  const loadSuppression = async () => {
    try {
      const res = await fetch("/api/suppression");
      const d = await res.json();
      if (d.success) setSuppression(d.emails.join("\n"));
    } catch {}
  };
  const saveSuppression = async () => {
    try {
      const emails = suppression.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await fetch("/api/suppression", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      setError("Suppression list saved.");
    } catch {}
  };
  const loadAudit = async () => {
    try {
      const res = await fetch("/api/audit?limit=100");
      const d = await res.json();
      if (d.success) setAuditLog(d.entries);
    } catch {}
  };

  const totalDone = job
    ? Object.values(job.perAccount).reduce((s, a) => s + a.done, 0)
    : 0;
  const progressPct = job && job.total > 0 ? Math.round((totalDone / job.total) * 100) : 0;
  const jobFinished = job?.status === "done";

  const recipientCount = recipients.length;
  const validCount = recipientCount - invalidEmails.length;

  return (
    <main className="app">
      <header className="header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /></div>
          <div>
            <p className="eyebrow">Mindful outreach studio</p>
            <h1>Gmail Mailer</h1>
            <span className="subtitle">Thoughtful email delivery, rooted in clarity.</span>
          </div>
        </div>
        <div className="header-metrics" aria-label="Campaign summary">
          <div className="header-metric">
            <strong>{selected.size}</strong>
            <span>active senders</span>
          </div>
          <div className="header-metric">
            <strong>{validCount}</strong>
            <span>ready recipients</span>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Mailer sections">
        {(["compose", "recipients", "settings", "logs"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? "active" : ""}`}
            onClick={() => {
              setTab(t);
              if (t === "settings") loadSuppression();
              if (t === "logs") loadAudit();
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {tab === "compose" && (
        <div className="grid">
          <section className="panel compose-sidebar">
            <p className="section-eyebrow">Sender garden</p>
            <h2>Choose accounts</h2>
            <div className="account-list">
              <div className="account-row">
                <label className="account-label">
                  <input type="checkbox" checked={accounts.length > 0 && selected.size === accounts.length} onChange={toggleAll} />
                  <span className="account-name">All accounts</span>
                </label>
              </div>
              {accounts.map((email) => (
                <div key={email} className="account-row">
                  <label className="account-label">
                    <input type="checkbox" checked={selected.has(email)} onChange={() => toggleAccount(email)} />
                    <span className="account-name">{email}</span>
                  </label>
                  <button
                    type="button"
                    className="trash-btn"
                    aria-label={`Delete account ${email}`}
                    title={`Delete account ${email}`}
                    onClick={() => removeAccount(email)}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" y1="11" x2="10" y2="17" />
                      <line x1="14" y1="11" x2="14" y2="17" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="link-btn full" onClick={connectAccount}>
              + Connect account
            </button>
            {accounts.length === 0 && (
              <p className="muted">No accounts. Click above to add via OAuth.</p>
            )}
            <p className="panel-note">Selected accounts share recipients evenly, with their own measured delivery pace.</p>

            <p className="section-eyebrow">Campaign details</p>
            <h2>Name your note</h2>
            <input type="text" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Campaign name" />

            <p className="section-eyebrow">Message essentials</p>
            <h2>Set the tone</h2>
            <label className="field">
              <span>From display name (optional)</span>
              <input type="text" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="e.g. Support Team" />
            </label>
            <label className="field">
              <span>Subjects — one per line, a random one is used per email (supports [-variables-])</span>
              <textarea
                className="textarea"
                rows={3}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={"Hello [-fullname-]\nImportant update for [-company-]\nQuick question"}
              />
              <div className="var-grid mt-6">
                {RANDOM_VARS.map((v) => (
                  <code
                    key={v}
                    className={`var-chip copy-chip ${copiedVar === v ? "copied" : ""}`}
                    onClick={() => copyVar(v)}
                  >{`[-${v}-]`}</code>
                ))}
              </div>
              <span className="muted mt-6">
                {subjectLines.length === 0
                  ? "No subjects yet."
                  : `${subjectLines.length} subject${subjectLines.length === 1 ? "" : "s"} — each email picks one at random.`}
              </span>
            </label>

            <div className="test-card">
              <div className="field-head">
                <span className="label-text">Test send</span>
                <span className="test-badge">Review first</span>
              </div>
              <select value={testAcc} onChange={(e) => setTestAcc(e.target.value)} className="select">
                <option value="">Pick account</option>
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <input type="text" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="recipient@example.com" className="mt-6" />
              <button type="button" className="link-btn full mt-6" onClick={testSend}>Send test note</button>
              {testStatus && <p className="muted mt-4">{testStatus}</p>}
            </div>
          </section>

          <section className="panel editor-panel">
            <div className="field-head">
              <div>
                <p className="section-eyebrow">Message studio</p>
                <h2>Shape your HTML note</h2>
              </div>
              <div className="row-gap">
                <button type="button" className="link-btn" onClick={() => loadFile("body.txt")}>Load body.txt</button>
                <button type="button" className="link-btn" onClick={() => setShowPreview(!showPreview)}>
                  {showPreview ? "Hide preview" : "Preview"}
                </button>
              </div>
            </div>
            <textarea className="textarea mono" rows={16} value={body}
              onChange={(e) => setBody(e.target.value)} placeholder="<html><body><p>Hello [-firstname-]</p></body></html>" />
            <p className="editor-hint">Add a personal touch with variables such as <code>[-firstname-]</code>, <code>[-company-]</code>, and <code>[-date-]</code>.</p>

            {showPreview && (
              <div className="preview">
                <div className="field-head">
                  <span className="label-text">Subject preview ({resolvedSubjects.length || "empty"})</span>
                </div>
                {resolvedSubjects.length === 0 ? (
                  <p className="preview-subject">(empty)</p>
                ) : (
                  <ul className="subject-list">
                    {resolvedSubjects.map((s, i) => (
                      <li key={i} className="preview-subject">{s}</li>
                    ))}
                  </ul>
                )}
                <div className="field-head"><span className="label-text">HTML preview</span></div>
                <iframe className="preview-iframe" srcDoc={resolvedHtml} title="preview" sandbox="" />
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "recipients" && (
        <div className="grid">
          <section className="panel recipient-panel">
            <p className="section-eyebrow">Recipient care</p>
            <h2>Grow your list</h2>
            <div className="row-gap mb-10">
              <label className="link-btn file-label">
                Upload CSV
                <input type="file" accept=".csv,.txt" onChange={handleCsvUpload} className="hidden-input" />
              </label>
            </div>
            <textarea className="textarea" rows={14} value={recipientsText}
              onChange={(e) => handleTextareaChange(e.target.value)} placeholder="one email per line" />
            <div className="stats-row">
              <span>Total: {recipientCount}</span>
              <span className="ok">Valid: {validCount}</span>
              <span className="fail">Invalid: {invalidEmails.length}</span>
              {recipients.some((r) => Object.keys(r).length > 1) && (
                <span className="accent">CSV fields loaded</span>
              )}
            </div>
            {invalidEmails.length > 0 && (
              <details className="mt-6">
                <summary className="muted cursor">Show invalid emails ({invalidEmails.length})</summary>
                <pre className="pre-wrap">{invalidEmails.slice(0, 50).join("\n")}{invalidEmails.length > 50 ? "\n..." : ""}</pre>
              </details>
            )}
          </section>
          <section className="panel variables-panel">
            <p className="section-eyebrow">Personal touches</p>
            <h2>Template variables</h2>
            <div className="var-grid">
              {[
                "email","emailuser","emaildomain","firstname","lastname","fullname",
                "company","jobtitle","phone","address","city","country","domain",
                "date","timestamp","unixtime","year",
              ].map((v) => (
                <code key={v} className="var-chip copy-chip" onClick={() => copyVar(v)}>{`[-${v}-]`}</code>
              ))}
            </div>
            <h2 className="mt-14">Random generators</h2>
            <div className="var-grid">
              {RANDOM_VARS.map((v) => (
                <code
                  key={v}
                  className={`var-chip copy-chip ${copiedVar === v ? "copied" : ""}`}
                  onClick={() => copyVar(v)}
                >{`[-${v}-]`}</code>
              ))}
            </div>
            <p className="muted mt-10">Use these placeholders in Subject and HTML body. Resolved per recipient at send time.</p>
            <h2 className="mt-14">CSV Format</h2>
            <p className="muted">
              First row must include an <code>email</code> column. Optional:{" "}
              <code>firstname, lastname, fullname, company, jobtitle, phone, address, city, country, domain</code>.
            </p>
          </section>
        </div>
      )}

      {tab === "settings" && (
        <div className="grid">
          <section className="panel">
            <p className="section-eyebrow">Delivery rhythm</p>
            <h2>Sending limits</h2>
            <label className="field">
              <span>Rate limit (ms) per account</span>
              <input type="number" value={rateLimitMs} onChange={(e) => setRateLimitMs(Number(e.target.value) || 1000)} min={100} step={100} />
            </label>
            <p className="muted">Delay between each email from the same account. Gmail recommends staying under 20/s.</p>
            <label className="field mt-10">
              <span>Max emails per account (per campaign)</span>
              <input type="number" value={maxPerAccount} onChange={(e) => setMaxPerAccount(Number(e.target.value) || 0)} min={1} />
            </label>
            <p className="muted">Cap the number of emails each account sends. Set 0 for unlimited.</p>
          </section>
          <section className="panel">
            <p className="section-eyebrow">Respectful exclusions</p>
            <h2>Suppression list</h2>
            <textarea className="textarea" rows={10} value={suppression}
              onChange={(e) => setSuppression(e.target.value)} placeholder="one suppressed email per line" />
            <button type="button" className="link-btn full mt-6" onClick={saveSuppression}>Save</button>
            <p className="muted mt-6">Emails listed here will be excluded from all campaigns.</p>
          </section>
        </div>
      )}

      {tab === "logs" && (
        <section className="panel">
          <div className="field-head">
            <div>
              <p className="section-eyebrow">Delivery journal</p>
              <h2>Audit log</h2>
            </div>
            <button type="button" className="link-btn" onClick={loadAudit}>Refresh</button>
          </div>
          {auditLog.length === 0 && <p className="muted">No entries yet.</p>}
          <div className="logs mt-10">
            {auditLog.map((entry, i) => (
              <div key={`${entry.ts}-${i}`} className={`log ${entry.status === "sent" ? "ok" : "fail"}`}>
                <span className="log-time">{new Date(entry.ts).toLocaleString()}</span>
                <span className="log-account">[{entry.account}]</span>
                <span>{entry.recipient}</span>
                <span className="log-campaign">{entry.campaign}</span>
                {entry.error && <span className="fail ml-4">{entry.error}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "clean" && (
        <div className="grid">
          <section className="panel compose-sidebar">
            <p className="section-eyebrow">Inbox hygiene</p>
            <h2>Choose accounts</h2>
            <div className="account-list">
              <div className="account-row">
                <label className="account-label">
                  <input type="checkbox" checked={accounts.length > 0 && selected.size === accounts.length} onChange={toggleAll} />
                  <span className="account-name">All accounts</span>
                </label>
              </div>
              {accounts.map((email) => (
                <div key={email} className="account-row">
                  <label className="account-label">
                    <input type="checkbox" checked={selected.has(email)} onChange={() => toggleAccount(email)} />
                    <span className="account-name">{email}</span>
                  </label>
                </div>
              ))}
            </div>
            {accounts.length === 0 && (
              <p className="muted">No accounts connected. Connect via the Compose tab first.</p>
            )}
            <button
              type="button"
              className="send-btn mt-10"
              onClick={cleanSent}
              disabled={cleaning || selected.size === 0}
            >
              {cleaning ? "Cleaning..." : "Clean sent folder"}
            </button>
            <p className="muted mt-6">
              Fetches sent messages and moves them to trash one by one with a 0.5–1.5s random delay per message, emulating normal human behavior. Deleted messages stay in Trash for 30 days before permanent removal.
            </p>
          </section>
          <section className="panel">
            <p className="section-eyebrow">Progress</p>
            <h2>Results</h2>
            {!cleanResults && !cleaning && (
              <p className="muted">Select accounts above and click Clean to begin.</p>
            )}
            {cleaning && <p className="muted">Deleting messages with human-like delays...</p>}
            {cleanResults && (
              <div className="account-progress">
                {Object.entries(cleanResults).map(([email, r]) => (
                  <div key={email} className="acct-chip">
                    <span className="acct-name">{email}</span>
                    {r.error ? (
                      <span className="fail">{r.error}</span>
                    ) : r.total === 0 ? (
                      <span className="muted">No sent messages found</span>
                    ) : (
                      <>
                        <span className="ok">{r.deleted} deleted</span>
                        <span className="fail">{r.total - r.deleted} failed</span>
                      </>
                    )}
                  </div>
                ))}
                <div className="stats-row">
                  <span className="ok">
                    Total deleted:{" "}
                    {Object.values(cleanResults).reduce((s, r) => s + (r.deleted ?? 0), 0)}
                  </span>
                </div>
              </div>
            )}
            {error && <p className="error mt-10">{error}</p>}
          </section>
        </div>
      )}

      <div className="actions send-dock">
        <button type="button" className="send-btn" onClick={send} disabled={sending && !jobFinished}>
          <span className="send-icon" aria-hidden="true">+</span>
          {sending && !jobFinished ? "Delivering..." : "Begin delivery"}
        </button>
        <span className="send-dock-note">Review your recipients, then send with care.</span>
        {error && <p className={`${error.startsWith("Suppression") ? "ok" : "error"}`}>{error}</p>}
        {stats && (
          <span className="muted">
            Ready: {stats.ready} | Invalid: {stats.invalid} | Suppressed: {stats.suppressed}
          </span>
        )}
      </div>

      {job && (
        <section className="panel progress-panel">
          <h2>{job.campaign} Progress</h2>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${progressPct}%` }} /></div>
          <div className="progress-stats">
            <span>{totalDone}/{job.total} processed</span>
            <span className="ok">{job.sent} sent</span>
            <span className="fail">{job.failed} failed</span>
            <span>{job.skipped} skipped</span>
            <span>{jobFinished ? "Completed" : "Running..."}</span>
          </div>
          <div className="account-progress">
            {Object.entries(job.perAccount).map(([email, p]) => (
              <div key={email} className="acct-chip">
                <span className="acct-name">{email}</span>
                <span className="ok">{p.sent} sent</span>
                <span className="fail">{p.failed} failed</span>
              </div>
            ))}
          </div>
          <div className="logs">
            {[...job.logs].reverse().slice(0, 50).map((log, i) => (
              <div key={`${log.ts}-${i}`} className={`log ${log.kind}`}>
                <span className="log-time">{new Date(log.ts).toLocaleTimeString()}</span>
                <span className="log-account">[{log.account}]</span>
                <span>{log.message}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
