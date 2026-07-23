import { NextResponse } from "next/server";
import { dataSource } from "@/backend/data";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "wb-crm-api",
    dataSource: dataSource(),
    time: new Date().toISOString(),
  });
}
