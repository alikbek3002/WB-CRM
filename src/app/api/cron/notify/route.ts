import { NextResponse } from "next/server";
import { schedulerTick } from "@/backend/telegram/scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

// Прод-вариант планировщика уведомлений (Vercel cron, раз в минуту/пять).
// Локально то же самое делает setInterval в процессе бота (scripts/run-bot.ts).
// Защита: authorization: Bearer ${CRON_SECRET}.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await schedulerTick();
  } catch (e) {
    console.error("[cron/notify]:", e);
    return NextResponse.json({ error: "tick_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
