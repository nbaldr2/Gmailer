import { NextResponse } from "next/server";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { cookies } from "next/headers";
import { TOKEN_DIR, PROJECT_ROOT } from "@/lib/gmail";

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
  const raw = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  return raw.installed ?? raw.web;
}

export async function GET(request: Request) {
  try {
    const origin = getOrigin(request);
    const { searchParams } = new URL(request.url);
    const error = searchParams.get("error");
    if (error) {
      return NextResponse.redirect(
        new URL(`/?error=${encodeURIComponent(error)}`, origin),
      );
    }
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    if (!code) {
      return NextResponse.redirect(
        new URL("/?error=missing_code", origin),
      );
    }

    const cookieStore = await cookies();
    const savedState = cookieStore.get("oauth_state")?.value;
    if (!savedState || savedState !== state) {
      return NextResponse.redirect(
        new URL("/?error=invalid_state", origin),
      );
    }
    cookieStore.delete("oauth_state");

    const secret = getSecret();
    const redirectUri = `${origin}/api/oauth/callback`;
    const client = new google.auth.OAuth2(
      secret.client_id,
      secret.client_secret,
      redirectUri,
    );
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      return NextResponse.redirect(
        new URL("/?error=no_refresh_token", origin),
      );
    }

    client.setCredentials(tokens);
    const profile = await google
      .gmail({ version: "v1", auth: client })
      .users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress!;

    const tokenData = {
      token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: secret.client_id,
      client_secret: secret.client_secret,
      scopes: SCOPES,
      account: "",
      expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null,
    };

    if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TOKEN_DIR, `token_gmail_v1_${email}.json`),
      JSON.stringify(tokenData, null, 2),
    );

    return NextResponse.redirect(
      new URL(`/?connected=${encodeURIComponent(email)}`, origin),
    );
  } catch (e: any) {
    return NextResponse.redirect(
      new URL(
        `/?error=${encodeURIComponent(e.message || "callback_failed")}`,
        getOrigin(request),
      ),
    );
  }
}