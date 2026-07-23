// Пуш-уведомления сотрудникам в Telegram — из любого места системы
// (API-роуты Next, планировщик бота, ИИ-инструменты).
// Чистый модуль: raw Bot API (fetch), supabase-js, относительные импорты.
// Ошибки отправки НЕ роняют вызывающий код (уведомление — best effort).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _db: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (_db) return _db;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _db;
}

export function tgEsc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Отправка по telegram_id (chat_id). HTML-разметка. true — доставлено.
export async function sendToTelegramId(
  telegramId: number | string,
  html: string,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text: html.slice(0, 4000),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch (e) {
    console.error("[notify] sendMessage failed:", e);
    return false;
  }
}

// Пуш сотруднику по id профиля (если Telegram привязан). true — доставлено.
export async function notifyProfile(profileId: string, html: string): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const { data } = await client
      .from("profiles")
      .select("telegram_id")
      .eq("id", profileId)
      .maybeSingle();
    if (!data?.telegram_id) return false;
    return await sendToTelegramId(data.telegram_id as number, html);
  } catch (e) {
    console.error("[notify] notifyProfile failed:", e);
    return false;
  }
}

// Пуш всем сотрудникам ролей (например, руководству). Возвращает число доставок.
export async function notifyRoles(roles: string[], html: string): Promise<number> {
  const client = db();
  if (!client) return 0;
  try {
    const { data: members } = await client
      .from("org_members")
      .select("user_id, role")
      .in("role", roles);
    const ids = [...new Set((members ?? []).map((m) => m.user_id as string))];
    if (!ids.length) return 0;
    const { data: profiles } = await client
      .from("profiles")
      .select("id, telegram_id")
      .in("id", ids)
      .not("telegram_id", "is", null);
    let sent = 0;
    for (const p of profiles ?? []) {
      if (await sendToTelegramId(p.telegram_id as number, html)) sent += 1;
    }
    return sent;
  } catch (e) {
    console.error("[notify] notifyRoles failed:", e);
    return 0;
  }
}
