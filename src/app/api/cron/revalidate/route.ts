import { NextResponse } from "next/server";
import { invalidateWbData } from "@/backend/data/revalidate";

export const runtime = "nodejs";

// Сброс кэша чтения по запросу извне. Нужен процессам, которые пишут в БД, но
// не являются Next: Telegram-бот на Railway (long-polling) закрывает задачи,
// заводит расходы и поставки — веб обязан увидеть это сразу, а не через TTL.
// Защита та же, что у остальных cron-роутов: authorization: Bearer ${CRON_SECRET}.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  invalidateWbData();
  return NextResponse.json({ ok: true });
}
