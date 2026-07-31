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

  // Три трека, чтобы ни один запуск не упирался в таймаут:
  //   live    — остатки/заказы/продажи: инкрементально и часто;
  //   full    — то же + карточки и цены: реже;
  //   finance — отчёт о реализации, реклама и баланс: раз в сутки. Отдельно,
  //             потому что statistics и advert-api дают 1 запрос в минуту —
  //             прогон идёт минутами и не должен блокировать живые данные.
  const mode = new URL(request.url).searchParams.get("mode");
  const sources: WbSyncSource[] | undefined =
    mode === "live"
      ? ["stocks", "orders", "sales"]
      : mode === "finance"
        ? ["finance", "advert"]
        : ["cards", "stocks", "orders", "sales"];

  // Финансам нужно окно шире: отчёты WB приходят неделями, а не днями
  const result = await runWbSync(admin, mode === "finance" ? 60 : 2, 3, sources);
  // Прогрев кэша здесь НЕ делаем: revalidateTag сбрасывает тег в конце ЭТОГО
  // запроса, прогретое выбрасывается. Планировщик бота после синка дёргает
  // отдельный /api/cron/warm — там прогрев реально сохраняется.
  if (result.ok) invalidateWbData(); // свежие заказы/остатки видно сразу
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
