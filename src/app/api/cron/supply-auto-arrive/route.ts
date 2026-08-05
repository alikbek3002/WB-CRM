import { NextResponse } from "next/server";
import { SUPPLY_AUTO_ARRIVE_DAYS } from "@/shared/constants";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { invalidateWbData, SUPPLY_SCOPES } from "@/backend/data/revalidate";

export const runtime = "nodejs";

// Персист авто-статуса «Приехал»: поставки «В пути» дольше N дней → «Приехал».
// Защита заголовком CRON_SECRET (Vercel Cron шлёт его в Authorization).
// Настройка расписания — в vercel.json/vercel.ts (напр. раз в сутки).
// В демо-режиме статус и так вычисляется на чтении (effectiveSupplyStatus).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, updated: 0 });
  }

  // Локальная дата (пояс UTC+5/6): сегодня минус порог
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - SUPPLY_AUTO_ARRIVE_DAYS);
  const y = cutoff.getFullYear();
  const mo = String(cutoff.getMonth() + 1).padStart(2, "0");
  const d = String(cutoff.getDate()).padStart(2, "0");
  const cutoffIso = `${y}-${mo}-${d}`;

  const { data, error } = await admin
    .from("supplies")
    .update({ status: "arrived" })
    .eq("status", "in_transit")
    .lte("ship_date", cutoffIso)
    .select("id");

  if (error) {
    console.error("[cron/supply-auto-arrive] update failed:", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  if ((data?.length ?? 0) > 0) invalidateWbData(...SUPPLY_SCOPES);
  return NextResponse.json({ ok: true, persisted: true, updated: data?.length ?? 0 });
}
