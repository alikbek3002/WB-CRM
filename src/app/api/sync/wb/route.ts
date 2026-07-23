import { NextResponse } from "next/server";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { runWbSync } from "@/backend/wb/sync";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";
export const maxDuration = 300; // синхронизация крупного кабинета небыстрая

// Ручной запуск синхронизации WB (кнопка на «Интеграциях»). integrations:manage.
export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "integrations:manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: "supabase_not_configured" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const days = Math.min(30, Math.max(1, Number(body?.days) || 30));
  const maxBatches = Math.min(5, Math.max(1, Number(body?.maxBatches) || 2));

  const result = await runWbSync(admin, days, maxBatches);
  if (result.ok) invalidateWbData(); // свежие заказы/остатки видно сразу
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
