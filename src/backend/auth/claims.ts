// Локальная проверка JWT вместо похода в Supabase Auth.
//
// ЗАЧЕМ. getUser() на КАЖДЫЙ запрос бьёт по сети в /auth/v1/user. С нашей
// латентностью до Supabase (~300–500 мс) это давало ~600 мс на любую навигацию:
// один вызов в middleware + второй в getSession() — ещё до чтения данных.
// Замеры (прод-сборка, кэш данных тёплый): аноним 3–9 мс, залогиненный 565–1110 мс.
//
// КАК. Проект использует асимметричные ключи подписи (ES256, /.well-known/jwks.json),
// поэтому подпись токена проверяется ЛОКАЛЬНО через crypto.subtle — сеть не нужна.
// Гарантия та же, что у getUser(): подделать токен без приватного ключа нельзя.
//
// JWKS кэшируем на уровне модуля: auth-js держит кэш в экземпляре клиента, а
// createServerClient создаёт новый экземпляр на каждый запрос — без общего кэша
// JWKS тянулся бы по сети каждый раз и экономии не было бы.

import type { SupabaseClient } from "@supabase/supabase-js";

// Структурно совместим с JWK из @supabase/auth-js (он не реэкспортится наружу
// из supabase-js, а тянуть транзитивную зависимость по прямому пути не хочется)
type Jwk = {
  kty: string;
  key_ops: string[];
  alg?: string;
  kid?: string;
  [k: string]: unknown;
};

const JWKS_TTL_MS = 10 * 60 * 1000;

let jwksCache: { keys: Jwk[] } | null = null;
let jwksCachedAt = 0;
let jwksInFlight: Promise<{ keys: Jwk[] } | null> | null = null;

async function loadJwks(): Promise<{ keys: Jwk[] } | null> {
  const now = Date.now();
  if (jwksCache && jwksCachedAt + JWKS_TTL_MS > now) return jwksCache;
  // Один запрос на процесс даже при параллельных вызовах
  if (jwksInFlight) return jwksInFlight;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  jwksInFlight = (async () => {
    try {
      const res = await fetch(`${url}/auth/v1/.well-known/jwks.json`, {
        headers: { apikey: key },
        // Ключи подписи меняются раз в жизни проекта — кэшируем и на уровне fetch
        cache: "force-cache",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { keys?: Jwk[] };
      if (!data.keys?.length) return null;
      jwksCache = { keys: data.keys };
      jwksCachedAt = Date.now();
      return jwksCache;
    } catch {
      return null; // сеть недоступна — вызывающий откатится на getUser()
    } finally {
      jwksInFlight = null;
    }
  })();

  return jwksInFlight;
}

/** Есть ли вообще кука сессии Supabase — если нет, проверять нечего. */
export function hasAuthCookie(
  cookies: { name: string }[] | { getAll: () => { name: string }[] },
): boolean {
  const all = Array.isArray(cookies) ? cookies : cookies.getAll();
  return all.some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));
}

export type VerifiedUser = { id: string; email: string | null };

/**
 * Пользователь текущего запроса. Подпись токена проверяется локально (ES256),
 * протухший токен молча обновляется через refresh_token — как и раньше.
 * Возвращает null, если сессии нет или токен невалиден.
 */
export async function getVerifiedUser(
  supa: SupabaseClient,
): Promise<VerifiedUser | null> {
  const jwks = await loadJwks();

  // Нет JWKS (симметричный ключ / сеть легла) — честный откат на сетевой getUser()
  if (!jwks) {
    const { data } = await supa.auth.getUser();
    return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
  }

  const { data, error } = await supa.auth.getClaims(undefined, { jwks });
  if (error || !data?.claims?.sub) return null;

  const claims = data.claims as { sub: string; email?: string };
  return { id: claims.sub, email: claims.email ?? null };
}
