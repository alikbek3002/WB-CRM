import { NextResponse } from "next/server";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getDashboardData } from "@/backend/data";

export const runtime = "nodejs";

// KPI и данные графиков дашборда (раздел 11.1 плана).
// Роль проверяется на сервере — раздел 5 плана требует дублировать RBAC вне UI.
export async function GET() {
  const session = await getSession();
  if (!can(session.role, "dashboard:view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(await getDashboardData());
}
