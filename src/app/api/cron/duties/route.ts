import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { ensureDutyAssignments } from "@/backend/data/supabase";

export const runtime = "nodejs";

// Утренняя генерация регламентных задач дня + пометка просроченных (missed).
// Генерация также происходит лениво при чтении страниц «Регламент»/«Отчёты» —
// cron нужен, чтобы задачи «приходили» даже если никто не открывал CRM.
// Защита: authorization: Bearer ${CRON_SECRET}.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  try {
    await ensureDutyAssignments(admin);
  } catch (e) {
    console.error("[cron/duties] generation failed:", e);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
