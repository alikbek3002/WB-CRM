// Одноразовый бэкфилл raw_sales.tech_size (миграция 0038).
// Строки, синхронизированные до 0038, не несут размера, а курсор синка
// (max last_change_date) старые продажи повторно не заберёт. Поэтому тянем
// /supplier/sales заново с dateFrom = 45 дней назад и апсертим по
// store_id+srid+sale_id — существующие строки получают tech_size.
//
// Почему 45 дней достаточно: dateFrom фильтрует по lastChangeDate, а запись
// не может измениться раньше, чем возникла, — значит, все продажи с sale_date
// в 30-дневном окне скорости покрыты с запасом.
//
// Запуск:  node --env-file=.env.local --import tsx scripts/backfill-sales-sizes.ts
// Продолжить с места обрыва: передать курсор аргументом —
//   … scripts/backfill-sales-sizes.ts 2026-07-18T15:29:51

import { createClient } from "@supabase/supabase-js";
import { fetchSales, getWbToken } from "../src/backend/wb/client";
import { DEMO_STORE_ID } from "../src/shared/constants";

const BACKFILL_DAYS = 45;
const WB_BATCH_LIMIT = 80_000; // максимум строк в ответе statistics-api
const RATE_WAIT_MS = 61_000; // лимит эндпоинта: 1 запрос/мин
const MAX_BATCHES = 6;
const CHUNK = 500;

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = getWbToken();
  if (!url || !key || !token) {
    console.error("✗ Нужны NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY и WB_API_TOKEN в .env.local");
    process.exit(1);
  }

  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const start = new Date();
  start.setDate(start.getDate() - BACKFILL_DAYS);
  let dateFrom = process.argv[2] ?? start.toISOString().slice(0, 19);
  let total = 0;

  // Сетевые сбои (DNS, обрыв) — транзиентные: ретрай с паузой, курсор не теряем
  const fetchWithRetry = async (from: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchSales(token, from, 300_000);
      } catch (e) {
        if (attempt >= 4) throw e;
        console.log(`  ! попытка ${attempt} не удалась (${(e as Error).message}), повтор через 30 с`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  };

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if (batch > 0) {
      console.log(`…пауза ${RATE_WAIT_MS / 1000} с (лимит 1 запрос/мин)`);
      await new Promise((r) => setTimeout(r, RATE_WAIT_MS));
    }
    console.log(`→ выгружаю продажи с ${dateFrom} (партия ${batch + 1})`);
    const rows = await fetchWithRetry(dateFrom);
    if (rows.length === 0) break;

    const mapped = rows
      .filter((s) => s.srid && s.saleID)
      .map((s) => ({
        store_id: DEMO_STORE_ID,
        srid: s.srid,
        sale_id: s.saleID,
        nm_id: s.nmId,
        sale_date: s.date,
        last_change_date: s.lastChangeDate,
        price_with_disc: s.priceWithDisc,
        for_pay: s.forPay,
        spp_percent: s.spp,
        tech_size: s.techSize ?? null,
        is_return: s.saleID.startsWith("R"),
      }));

    for (let i = 0; i < mapped.length; i += CHUNK) {
      const slice = mapped.slice(i, i + CHUNK);
      // Апсерт идемпотентен — сетевые сбои просто ретраим
      for (let attempt = 1; ; attempt++) {
        const { error } = await db
          .from("raw_sales")
          .upsert(slice, { onConflict: "store_id,srid,sale_id" });
        if (!error) break;
        if (attempt >= 4) throw new Error(`upsert raw_sales: ${error.message}`);
        console.log(`  ! upsert не прошёл (${error.message}), повтор через 10 с`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    total += mapped.length;
    console.log(`  ✓ ${mapped.length} строк (всего ${total})`);

    if (rows.length < WB_BATCH_LIMIT) break; // хвост забрали
    dateFrom = rows.reduce(
      (max, r) => (r.lastChangeDate > max ? r.lastChangeDate : max),
      dateFrom,
    );
  }

  // Контроль: сколько продаж окна скорости получили размер
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);
  const win = db
    .from("raw_sales")
    .select("id", { count: "exact", head: true })
    .eq("store_id", DEMO_STORE_ID)
    .gte("sale_date", since.toISOString());
  const [{ count: all }, { count: sized }] = await Promise.all([
    win,
    db
      .from("raw_sales")
      .select("id", { count: "exact", head: true })
      .eq("store_id", DEMO_STORE_ID)
      .gte("sale_date", since.toISOString())
      .not("tech_size", "is", null),
  ]);
  console.log(`✓ Готово: апсертнуто ${total}. Окно 30 дней: ${sized}/${all} строк с размером.`);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
