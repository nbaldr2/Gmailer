import { NextResponse } from "next/server";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { cookies } from "next/headers";
import { PROJECT_ROOT } from "@/lib/gmail";

const SCOPES = ["https://mail.google.com/"];

function getOrigin(request: Request): string {
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = (
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    ""
  )
    .split(",")[0]
    .trim();
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

function getSecret() {
  const secretPath = path.join(PROJECT_ROOT, "client_secret.json");
  if (!fs.existsSync(secretPath)) {
    throw new Error(
      "client_secret.json not found in project root. " +
      "Place your OAuth 2.0 desktop client secret file there.",
    );
  }
  const raw = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  return raw.installed ?? raw.web;
}

export async function GET(request: Request) {
  try {
    const secret = getSecret();
    const origin = getOrigin(request);
    const redirectUri = `${origin}/api/oauth/callback`;
    const client = new google.auth.OAuth2(
      secret.client_id,
      secret.client_secret,
      redirectUri,
    );
    const state = Math.random().toString(36).slice(2);
    const cookieStore = await cookies();
    cookieStore.set("oauth_state", state, {
      httpOnly: true,
      maxAge: 600,
      path: "/",
      sameSite: "lax",
    });
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
    });
    return NextResponse.json({ success: true, url });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, message: e.message || String(e) },
      { status: 500 },
    );
  }
}