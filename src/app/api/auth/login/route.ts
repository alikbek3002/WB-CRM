import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/backend/supabase/server";
import { getSupabaseAdmin } from "@/backend/supabase/admin";

export const runtime = "nodejs";

// Вход в личный кабинет: логин (или email) + пароль → Supabase Auth сессия
// в cookies. Логины выдаёт директор (см. bootstrap.mjs / Команда).
const loginSchema = z.object({
  login: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(100),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const supa = await createSupabaseServerClient();
  const admin = getSupabaseAdmin();
  if (!supa || !admin) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }

  // Логин → email (одинаковый ответ на все ошибки — не раскрываем, что именно неверно)
  let email = parsed.data.login.toLowerCase();
  if (!email.includes("@")) {
    const { data: profile } = await admin
      .from("profiles")
      .select("email")
      .ilike("login", email)
      .maybeSingle();
    if (!profile?.email) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }
    email = profile.email as string;
  }

  const { data, error } = await supa.auth.signInWithPassword({
    email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
