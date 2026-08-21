import { NextResponse } from "next/server";
import {
  deleteCampaign,
  deleteAllRejectedCampaigns,
  listCampaignRejections,
  listRejectedCampaigns,
} from "@/lib/rejections-db";

function csvCell(value: string | null | undefined): string {
  const text = value ?? "";
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "true") {
      const deleted = await deleteAllRejectedCampaigns();
      return NextResponse.json({ success: true, deleted });
    }
    const campaignId = url.searchParams.get("campaignId");
    if (!campaignId) {
      return NextResponse.json(
        { success: false, message: "Campaign ID is required" },
        { status: 400 },
      );
    }
    const deleted = await deleteCampaign(campaignId);
    if (!deleted) {
      return NextResponse.json(
        { success: false, message: "Campaign not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const campaignId = url.searchParams.get("campaignId");
    if (url.searchParams.get("format") === "csv") {
      if (!campaignId) {
        return NextResponse.json(
          { success: false, message: "Campaign ID is required for CSV export" },
          { status: 400 },
        );
      }
      const campaigns = await listRejectedCampaigns();
      const campaign = campaigns.find((item) => item.id === campaignId);
      if (!campaign) {
        return NextResponse.json(
          { success: false, message: "Campaign not found" },
          { status: 404 },
        );
      }
      const rows = await listCampaignRejections(campaignId);
      const csv = [
        ["Campaign ID", "Campaign", "From name", "Recipient", "Sender account", "Source", "Reason", "Detected at"].join(","),
        ...rows.map((row) => [
          campaign.id,
          campaign.name,
          campaign.fromName,
          row.recipientEmail,
          row.senderAccount,
          row.kind,
          row.reason,
          row.detectedAt,
        ].map(csvCell).join(",")),
      ].join("\r\n");
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${campaignId}-rejections.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const campaigns = await listRejectedCampaigns();
    return NextResponse.json({ success: true, campaigns });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}
