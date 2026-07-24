import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { runWbSync, type WbSyncSource } from "@/backend/wb/sync";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";
export const maxDuration = 300;

// Регулярная синхронизация WB (Vercel cron / внешний планировщик).
// Защита: authorization: Bearer ${CRON_SECRET}. Окно 2 дня — инкрементально
// докатывает свежие заказы/продажи, статусы и остатки.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: "supabase_not_configured" },
      { status: 503 },
    );
  }

  // mode=live → только живые данные (остатки/заказы/продажи): инкрементально и часто.
  // Иначе полный синк (+ карточки/цены) — реже. Разводит их планировщик бота.
  const mode = new URL(request.url).searchParams.get("mode");
  const sources: WbSyncSource[] | undefined =
    mode === "live" ? ["stocks", "orders", "sales"] : undefined;

  const result = await runWbSync(admin, 2, 3, sources);
  // Прогрев кэша здесь НЕ делаем: revalidateTag сбрасывает тег в конце ЭТОГО
  // запроса, прогретое выбрасывается. Планировщик бота после синка дёргает
  // отдельный /api/cron/warm — там прогрев реально сохраняется.
  if (result.ok) invalidateWbData(); // свежие заказы/остатки видно сразу
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
