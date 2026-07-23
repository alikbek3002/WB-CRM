import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Сервисный клиент Supabase (service_role). ОБХОДИТ RLS — использовать ТОЛЬКО
// в серверном коде (Route Handlers, Server Actions, RSC, воркеры синка).
// Никогда не импортировать в клиентские компоненты. Раздел 13 плана.
//
// Пока полноценной multi-tenant авторизации нет, чтение/запись идут через этот
// клиент и ограничены демо-тенантом (src/shared/constants.ts). Проверка ролей —
// на уровне RBAC (src/shared/rbac.ts) в страницах и API-роутах.

let cached: SupabaseClient | null = null;

export function isSupabaseServiceConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isSupabaseServiceConfigured()) return null;
  if (cached) return cached;

  cached = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
  return cached;
}
