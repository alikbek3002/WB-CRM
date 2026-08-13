// Курсы валют к сому — единственное место, откуда система узнаёт курс.
//
// Читают все, кто показывает деньги (касса, расходы, поставки, фабрики, ИИ),
// правят директор и старший менеджер (право currency:manage) на вкладке
// «Финансы → Валюты». Базовая валюта — сом, её курс всегда 1 (см. shared/currency.ts).
//
// Чистый модуль (npm + относительные импорты) — работает и в Next, и в tsx (бот).

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG_ID } from "../../shared/constants";
import {
  BASE_CURRENCY,
  CURRENCY_CODES,
  CURRENCY_LABEL,
  CURRENCY_NAME,
  CURRENCY_SIGN,
  DEFAULT_RATES_TO_BASE,
  isCurrencyCode,
  type CurrencyCode,
  type CurrencyRateMap,
} from "../../shared/currency";
import { can, type MemberRole } from "../../shared/rbac";
import type { CurrencyRate, CurrencyRatesView } from "../../shared/types";

export type CurrencyActor = {
  id: string;
  name: string;
  role: MemberRole;
  roleLabel: string;
};

export type CurrencyResult =
  | { ok: true; code: CurrencyCode; rate: number; message: string }
  | { ok: false; code: "forbidden" | "invalid" | "db_error"; message: string };

// Разумные границы курса: 1 000 000 сомов за единицу — уже опечатка, ноль и
// минус — тем более. Без этого один неверный ввод перекосил бы всю отчётность.
const RATE_MIN = 0.000001;
const RATE_MAX = 1_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RateRow = {
  code: string;
  rate_to_kgs: number | string;
  updated_at: string | null;
  updated_by: string | null;
  author: { full_name: string | null } | { full_name: string | null }[] | null;
};

const SELECT =
  "code, rate_to_kgs, updated_at, updated_by, " +
  "author:profiles!currency_rates_updated_by_fkey(full_name)";

function first<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// Курсы для интерфейса: все валюты по порядку, даже те, что ещё не сводили —
// иначе директор не увидит, что у сума стоит наш ориентир, а не его курс.
export async function readCurrencyRates(db: SupabaseClient): Promise<CurrencyRatesView> {
  const { data, error } = await db
    .from("currency_rates")
    .select(SELECT)
    .eq("org_id", DEMO_ORG_ID);

  // Миграция 0043 ещё не накатана — работаем на дефолтах, а не падаем: деньги
  // показать важнее, чем настаивать на схеме.
  if (error) {
    console.error("[currency] read failed:", error.message);
    return defaultRatesView();
  }

  const byCode = new Map<string, RateRow>();
  for (const row of (data ?? []) as unknown as RateRow[]) byCode.set(String(row.code), row);

  const rates: CurrencyRate[] = CURRENCY_CODES.map((code) => {
    const row = byCode.get(code);
    const stored = row ? Number(row.rate_to_kgs) : NaN;
    const known = Number.isFinite(stored) && stored > 0;
    return {
      code,
      name: CURRENCY_NAME[code],
      sign: CURRENCY_SIGN[code],
      rateToBase: code === BASE_CURRENCY ? 1 : known ? stored : DEFAULT_RATES_TO_BASE[code],
      isBase: code === BASE_CURRENCY,
      updatedAt: row?.updated_at ?? null,
      updatedByName: first(row?.author ?? null)?.full_name ?? null,
      isDefault: !row || !row.updated_by,
    };
  });

  const edited = rates
    .filter((r) => !r.isDefault && r.updatedAt)
    .map((r) => r.updatedAt as string)
    .sort();

  return { base: BASE_CURRENCY, rates, updatedAt: edited.at(-1) ?? null };
}

function defaultRatesView(): CurrencyRatesView {
  return {
    base: BASE_CURRENCY,
    rates: CURRENCY_CODES.map((code) => ({
      code,
      name: CURRENCY_NAME[code],
      sign: CURRENCY_SIGN[code],
      rateToBase: DEFAULT_RATES_TO_BASE[code],
      isBase: code === BASE_CURRENCY,
      updatedAt: null,
      updatedByName: null,
      isDefault: true,
    })),
    updatedAt: null,
  };
}

export function ratesToMap(view: CurrencyRatesView): CurrencyRateMap {
  const map: CurrencyRateMap = {};
  for (const r of view.rates) map[r.code] = r.rateToBase;
  return map;
}

// ─── Карта курсов для расчётов ───────────────────────────────────────────────
// Курс читают почти все денежные экраны и каждая запись в кассу. Пять строк —
// дешёвый запрос, но не на каждый пересчёт строки: держим в памяти процесса
// минуту и сбрасываем сразу после правки, чтобы новый курс применился без
// ожидания TTL.

let cached: { map: CurrencyRateMap; at: number } | null = null;
const MEMO_MS = 60_000;

export async function readCurrencyRateMap(db: SupabaseClient): Promise<CurrencyRateMap> {
  if (cached && Date.now() - cached.at < MEMO_MS) return cached.map;
  const map = ratesToMap(await readCurrencyRates(db));
  cached = { map, at: Date.now() };
  return map;
}

export function clearCurrencyRateCache(): void {
  cached = null;
}

// ─── Правка курса ────────────────────────────────────────────────────────────

export async function setCurrencyRate(
  db: SupabaseClient,
  actor: CurrencyActor,
  input: { code: string; rate: number },
): Promise<CurrencyResult> {
  if (!can(actor.role, "currency:manage")) {
    return {
      ok: false,
      code: "forbidden",
      message: "Курсы валют сводят директор и старший менеджер.",
    };
  }

  const code = String(input.code ?? "").toLowerCase();
  if (!isCurrencyCode(code)) {
    return { ok: false, code: "invalid", message: "Неизвестная валюта." };
  }
  if (code === BASE_CURRENCY) {
    return {
      ok: false,
      code: "invalid",
      message: "Сом — базовая валюта: его курс к самому себе всегда 1.",
    };
  }

  const rate = Number(input.rate);
  if (!Number.isFinite(rate) || rate < RATE_MIN || rate > RATE_MAX) {
    return { ok: false, code: "invalid", message: "Курс должен быть положительным числом." };
  }

  const { error } = await db.from("currency_rates").upsert(
    {
      org_id: DEMO_ORG_ID,
      code,
      rate_to_kgs: rate,
      updated_by: UUID_RE.test(actor.id) ? actor.id : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,code" },
  );
  if (error) {
    return { ok: false, code: "db_error", message: error.message };
  }

  clearCurrencyRateCache();
  return {
    ok: true,
    code,
    rate,
    message: `Курс обновлён: 1 ${CURRENCY_LABEL[code]} = ${rate} ${CURRENCY_SIGN[BASE_CURRENCY]}.`,
  };
}
