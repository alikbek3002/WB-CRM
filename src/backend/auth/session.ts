import { cache } from "react";
import { unstable_cache } from "next/cache";
import { cookies } from "next/headers";
import { isMemberRole, ROLE_LABELS, type MemberRole } from "@/shared/rbac";
import { DEMO_ORG_ID } from "@/shared/constants";
import { SESSION_TAG } from "@/backend/data";
import { getVerifiedUser } from "@/backend/auth/claims";
import { getSupabaseAdmin } from "@/backend/supabase/admin";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/backend/supabase/server";

type MemberRow = {
  profile: { id: string; full_name?: string; email?: string } | null;
  org: { id: string; name: string } | null;
};

// ВАЖНО про тег: раньше эти два кэша висели на WB_DATA_TAG — то есть ЛЮБАЯ
// мутация (закрыл задачу, добавил расход) выбрасывала и строку членства, и
// следующая навигация снова шла в Supabase за одной строкой. Членство меняется
// только на вкладке «Команда», поэтому у него отдельный тег SESSION_TAG.

// Членство авторизованного пользователя (личный кабинет) — кэш по user_id
const loadMemberByUserId = unstable_cache(
  async (userId: string): Promise<(MemberRow & { role: string }) | null> => {
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const { data } = await admin
      .from("org_members")
      .select("role, profile:profiles(id, full_name, email), org:orgs(id, name)")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    return (data as unknown as MemberRow & { role: string }) ?? null;
  },
  ["session-member-uid"],
  { revalidate: 600, tags: [SESSION_TAG] },
);

// Выполняется в layout на КАЖДОЙ навигации — кэшируем между запросами, чтобы
// не ходить в Supabase за одной строкой при каждом переключении вкладки.
const loadMemberByRole = unstable_cache(
  async (role: MemberRole): Promise<MemberRow | null> => {
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const { data } = await admin
      .from("org_members")
      .select("profile:profiles(id, full_name, email), org:orgs(id, name)")
      .eq("org_id", DEMO_ORG_ID)
      .eq("role", role)
      .limit(1)
      .maybeSingle();
    return (data as unknown as MemberRow) ?? null;
  },
  ["session-member"],
  { revalidate: 600, tags: [SESSION_TAG] },
);

export const DEMO_ROLE_COOKIE = "wbcrm-demo-role";

export type Session = {
  user: { id: string; name: string; email: string };
  role: MemberRole;
  roleLabel: string;
  org: { id: string; name: string };
  isDemo: boolean;
  authenticated: boolean; // true — реальный вход по логину/паролю
};

const DEMO_USERS: Partial<Record<MemberRole, { name: string; email: string }>> = {
  owner: { name: "Айгерим Директорова", email: "director@demo.wbcrm" },
  manager: { name: "Жакыпбек", email: "zhakypbek@demo.wbcrm" },
};

// Сессия: сначала реальный вход (Supabase Auth → личный кабинет сотрудника),
// затем демо-переключатель ролей (cookie) для показа системы без логина.
// cache() дедуплицирует запрос в рамках одного запроса/рендера.
export const getSession = cache(async (): Promise<Session> => {
  // 1) Личный кабинет: авторизованный пользователь Supabase Auth.
  // Токен проверяется ЛОКАЛЬНО (getVerifiedUser) — раньше здесь был getUser()
  // с походом по сети (~300–500 мс) на каждый рендер каждой страницы.
  const supa = await createSupabaseServerClient();
  if (supa && getSupabaseAdmin()) {
    const user = await getVerifiedUser(supa);
    if (user) {
      const member = await loadMemberByUserId(user.id);
      const profile = member?.profile ?? null;
      if (profile && isMemberRole(member!.role)) {
        const authRole = member!.role as MemberRole;
        const org = member?.org ?? null;
        return {
          user: {
            id: profile.id,
            name: profile.full_name ?? ROLE_LABELS[authRole],
            email: profile.email ?? user.email ?? "",
          },
          role: authRole,
          roleLabel: ROLE_LABELS[authRole],
          org: { id: org?.id ?? DEMO_ORG_ID, name: org?.name ?? "Kimono Brand" },
          isDemo: false,
          authenticated: true,
        };
      }
    }
  }

  // 2) Демо-переключатель ролей (cookie) — ТОЛЬКО при ALLOW_DEMO=1 (локальная
  // разработка/демо). На проде выключено: без входа нет данных — (app)/layout
  // редиректит на /login, а API-роуты режутся can() (у viewer-заглушки нет прав
  // на мутации; страницы до неё не доходят).
  if (process.env.ALLOW_DEMO !== "1") {
    return {
      // Роль вне матрицы прав: can() отдаёт false на ЛЮБОЕ право (включая view),
      // поэтому прямые GET к /api/* без входа получают 403, а не данные.
      user: { id: "anonymous", name: "Гость", email: "" },
      role: "anonymous" as MemberRole,
      roleLabel: "Гость",
      org: { id: DEMO_ORG_ID, name: "—" },
      isDemo: false,
      authenticated: false,
    };
  }

  const cookieStore = await cookies();
  const rawRole = cookieStore.get(DEMO_ROLE_COOKIE)?.value ?? "owner";
  const role: MemberRole = isMemberRole(rawRole) ? rawRole : "owner";

  if (getSupabaseAdmin()) {
    const data = await loadMemberByRole(role);

    const profile = data?.profile ?? null;
    if (profile) {
      const org = data?.org ?? null;
      return {
        user: {
          id: profile.id,
          name: profile.full_name ?? ROLE_LABELS[role],
          email: profile.email ?? `${role}@demo.wbcrm`,
        },
        role,
        roleLabel: ROLE_LABELS[role],
        org: { id: org?.id ?? DEMO_ORG_ID, name: org?.name ?? "Kimono Brand" },
        isDemo: false,
        authenticated: false,
      };
    }
  }

  // Демо без БД (или до сида) — прежнее поведение на мок-данных
  const demoUser = DEMO_USERS[role] ?? {
    name: ROLE_LABELS[role],
    email: `${role}@demo.wbcrm`,
  };
  return {
    user: { id: `demo-${role}`, ...demoUser },
    role,
    roleLabel: ROLE_LABELS[role],
    org: { id: "demo-org", name: "Kimono Brand" },
    isDemo: !isSupabaseConfigured(),
    authenticated: false,
  };
});
