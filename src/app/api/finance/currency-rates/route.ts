import { NextResponse } from "next/server";
import { z } from "zod";
import { CURRENCY_CODES } from "@/shared/currency";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import { setCurrencyRate } from "@/backend/data/currency-core";
import { invalidateWbData, CURRENCY_SCOPES } from "@/backend/data/revalidate";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Курс валюты к сому. Сводят директор и старший менеджер (currency:manage):
// от этого числа зависят касса, ОПиУ, себестоимость партий и долги фабрикам.
const rateSchema = z.object({
  code: z.enum(CURRENCY_CODES),
  rate: z.number().positive().max(1_000_000),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!can(session.role, "currency:manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = rateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  // Демо-режим (нет БД): курс принят, но сохранить его некуда — так и отвечаем,
  // чтобы интерфейс не рисовал «сохранено» вместо честного предупреждения.
  if (!admin) {
    return NextResponse.json({ ok: true, persisted: false, ...parsed.data });
  }

  const result = await setCurrencyRate(
    admin,
    {
      id: UUID.test(session.user.id) ? session.user.id : "",
      name: session.user.name,
      role: session.role,
      roleLabel: session.roleLabel,
    },
    parsed.data,
  );
  if (!result.ok) {
    const status = result.code === "forbidden" ? 403 : result.code === "db_error" ? 500 : 400;
    if (result.code === "db_error") console.error("[currency-rates] upsert failed:", result.message);
    return NextResponse.json({ error: result.code, message: result.message }, { status });
  }

  // Курс — множитель под всеми суммами: сбрасываем весь денежный кэш, иначе на
  // вкладках останутся числа по старому курсу.
  invalidateWbData(...CURRENCY_SCOPES);
  return NextResponse.json({
    ok: true,
    persisted: true,
    code: result.code,
    rate: result.rate,
    message: result.message,
  });
}
