import { NextResponse } from "next/server";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { runWbSync, WB_SYNC_SOURCES, type WbSyncSource } from "@/backend/wb/sync";
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
  const days = Math.min(90, Math.max(1, Number(body?.days) || 30));
  // до 10 партий — хватает на разовый бэкфилл storage (8 окон по 8 дней)
  const maxBatches = Math.min(10, Math.max(1, Number(body?.maxBatches) || 2));
  // Явный выбор источников (бэкфилл: {"sources":["storage"],"maxBatches":8});
  // без него — дефолтный набор без тяжёлых task-based отчётов
  const sources = Array.isArray(body?.sources)
    ? (body.sources as string[]).filter((s): s is WbSyncSource =>
        (WB_SYNC_SOURCES as readonly string[]).includes(s),
      )
    : undefined;

  const result = await runWbSync(
    admin,
    days,
    maxBatches,
    sources && sources.length ? sources : undefined,
  );
  if (result.ok) invalidateWbData(); // свежие заказы/остатки видно сразу
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
