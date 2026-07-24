import { NextResponse } from "next/server";
import { warmReadCache } from "@/backend/data";

export const runtime = "nodejs";
export const maxDuration = 120;

// Прогрев кэша чтения ПОСЛЕ синка WB. Отдельный запрос обязателен: revalidateTag
// в cron/wb-sync сбрасывает тег в конце СВОЕГО запроса — прогрев там бесполезен.
// Дёргает планировщик бота (scheduler.ts) сразу после успешного синка.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const warm = await warmReadCache();
  console.log(`[warm] кэш прогрет за ${warm.ms}мс (ошибок: ${warm.failed})`);
  return NextResponse.json({ ok: warm.failed === 0, ...warm });
}
