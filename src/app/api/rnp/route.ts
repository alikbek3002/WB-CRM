import { NextResponse } from "next/server";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getRnpProducts } from "@/backend/data";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!can(session.role, "rnp:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ products: await getRnpProducts() });
}
