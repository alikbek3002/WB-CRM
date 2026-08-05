import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getVerifiedUser, hasAuthCookie } from "@/backend/auth/claims";

// Обновление auth-сессии Supabase (refresh токенов) на каждый запрос.
// Без этого личные кабинеты разлогинивались бы через час (RSC не может
// переустанавливать куки — это делает middleware).
//
// ПРОИЗВОДИТЕЛЬНОСТЬ. Раньше здесь звался getUser() — поход по сети в Supabase
// Auth (~300–500 мс) на КАЖДЫЙ запрос, включая префетчи ссылок. Теперь подпись
// токена проверяется локально (getVerifiedUser → ES256 + кэш JWKS), а по сети
// ходим только когда токен реально протух и нужен refresh.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  // Куки сессии нет (демо-режим, /login, гость) — обновлять нечего.
  // Экономит создание клиента и разбор кук на каждом запросе.
  if (!hasAuthCookie(request.cookies)) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  await getVerifiedUser(supabase);
  return response;
}

export const config = {
  matcher: [
    // Статику, картинки и машинные роуты (крон/вебхук телеграма — там нет
    // пользовательских кук) через middleware не гоняем.
    "/((?!_next/static|_next/image|favicon\\.ico|api/cron|api/telegram|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
