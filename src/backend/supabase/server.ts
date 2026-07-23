import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// Ключи появятся позже (раздел 14 плана). До этого приложение работает
// в демо-режиме на мок-данных — см. src/backend/auth/session.ts и src/backend/data.
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

export async function createSupabaseServerClient() {
  if (!isSupabaseConfigured()) return null;

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Вызов из Server Component — куки обновит middleware
          }
        },
      },
    },
  );
}
