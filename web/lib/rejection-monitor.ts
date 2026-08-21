import { scanBounceAccounts, BounceScanAccountProgress } from "./bounce-scan-jobs";

const MONITOR_DURATION_MS = 30 * 60_000;
const SCAN_INTERVAL_MS = 60_000;

export interface RejectionMonitor {
  campaignId: string;
  status: "running" | "done";
  accounts: Record<string, BounceScanAccountProgress>;
  startedAt: number;
  endsAt: number;
  scans: number;
  lastScanAt?: number;
}

const monitors = new Map<string, RejectionMonitor>();

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startRejectionMonitor(campaignId: string, accounts: string[]) {
  if (monitors.get(campaignId)?.status === "running") return;
  const uniqueAccounts = [...new Set(accounts)];
  const monitor: RejectionMonitor = {
    campaignId,
    status: "running",
    accounts: Object.fromEntries(
      uniqueAccounts.map((email) => [email, { examined: 0, imported: 0, unmatched: 0 }]),
    ),
    startedAt: Date.now(),
    endsAt: Date.now() + MONITOR_DURATION_MS,
    scans: 0,
  };
  monitors.set(campaignId, monitor);
  void runMonitor(monitor, uniqueAccounts);
}

async function runMonitor(monitor: RejectionMonitor, accounts: string[]) {
  while (Date.now() < monitor.endsAt) {
    await scanBounceAccounts(accounts, monitor.accounts);
    monitor.scans++;
    monitor.lastScanAt = Date.now();
    const remaining = monitor.endsAt - Date.now();
    if (remaining <= 0) break;
    await pause(Math.min(SCAN_INTERVAL_MS, remaining));
  }
  monitor.status = "done";
}

export function getRejectionMonitors(): RejectionMonitor[] {
  return [...monitors.values()].sort((a, b) => b.startedAt - a.startedAt);
}
