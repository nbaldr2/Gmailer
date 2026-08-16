import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "@/lib/gmail";

const ALLOWED = new Set(["emails.txt", "body.txt"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!ALLOWED.has(name)) {
    return NextResponse.json(
      { success: false, message: "File not allowed" },
      { status: 403 },
    );
  }
  const filePath = path.join(PROJECT_ROOT, name);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      { success: false, message: "File not found" },
      { status: 404 },
    );
  }
  const content = fs.readFileSync(filePath, "utf8");
  return NextResponse.json({ success: true, name, content });
}
