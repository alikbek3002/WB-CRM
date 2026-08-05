-- 0036 — производительность холодного чтения.
--
-- Замеры до (прод-база, ap-northeast-1):
--   agg_orders_by_warehouse  6.2 с   ← вкладка «Остатки» грузилась 9–12 с
--   agg_unit_econ            5.2 с   ← «Экономика», «Товары», РНП, ОПиУ
--   остальные агрегаты      0.35–0.5 с (это фактически только сеть)
--
-- Обе причины — не объём данных, а то, что индекс не мог примениться.

-- ─── 1. agg_orders_by_warehouse: 627k строк raw_orders ────────────────────────
-- Было: Index Scan по (store_id, order_date) + поход в кучу за warehouse/is_cancel
-- на каждую строку — 319 493 буфера на 358k строк.
-- Стало: Index Only Scan по частичному покрывающему индексу — 8 964 буфера (в 35 раз
-- меньше), 6.2 с → 0.49 с. Отменённые заказы в индекс вообще не попадают.
create index if not exists idx_raw_orders_wh_agg
  on raw_orders (store_id, order_date, warehouse)
  where not coalesce(is_cancel, false);

-- Index Only Scan работает по карте видимости, а её обновляет vacuum. Синк WB
-- только ВСТАВЛЯЕТ строки, мёртвых кортежей не создаёт — обычный порог
-- autovacuum по ним не срабатывает, и карта видимости устаревала бы после
-- каждого синка (тогда сканирование снова лезет в кучу). Порог по вставкам
-- (PG 13+) держит её свежей.
alter table raw_orders set (
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_vacuum_insert_threshold = 20000
);

-- ─── 2. agg_unit_econ и Ко: 534k строк raw_finance_report ────────────────────
-- Дата операции в отчёте WB собирается из трёх колонок:
--   coalesce(sale_dt::date, rr_dt, period_start)
-- В таком виде выражение НЕ САРЖАБЕЛЬНО — ни один из трёх существующих индексов
-- (store_saledt / store_rrdt / period) применить нельзя, и каждый вызов читал
-- всю таблицу целиком (197 МБ).
--
-- Индексировать coalesce(sale_dt::date, …) напрямую нельзя: sale_dt — timestamptz,
-- и приведение ::date зависит от TimeZone сессии, то есть STABLE, а не IMMUTABLE.
-- Явное `at time zone 'UTC'` делает выражение IMMUTABLE и индексируемым.
--
-- ЭКВИВАЛЕНТНОСТЬ ПРОВЕРЕНА НА ДАННЫХ, а не на предположении: TimeZone базы = UTC,
-- и запрос
--   select count(*) from raw_finance_report
--    where sale_dt::date is distinct from (sale_dt at time zone 'UTC')::date;
-- вернул 0 при 533 980 строках. Цифры в отчётах не меняются.
create index if not exists idx_raw_finance_econ_date
  on raw_finance_report
     (store_id, (coalesce((sale_dt at time zone 'UTC')::date, rr_dt, period_start)));

alter table raw_finance_report set (
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_vacuum_insert_threshold = 20000
);

-- ─── 3. Функции переводим на то же выражение, что и в индексе ────────────────
-- Тело не меняется, меняется только форма даты в where/group by.

-- Юнит-экономика по товарам (0035)
create or replace function agg_unit_econ(p_store uuid, p_from date, p_to date)
returns table(
  nm_id bigint, sale_qty bigint, return_qty bigint, revenue_rub numeric,
  for_pay_rub numeric, commission_rub numeric, acquiring_rub numeric,
  logistics_rub numeric, storage_fin_rub numeric, storage_rub numeric,
  acceptance_fin_rub numeric, acceptance_rub numeric, penalty_rub numeric,
  deduction_rub numeric, advert_rub numeric, advert_views bigint, advert_clicks bigint
)
language sql stable as $$
  with fin as (
    select coalesce(f.nm_id, 0) as nm,
      sum(case when f.doc_type = 'Возврат' then 0 else coalesce(f.quantity, 0) end)::bigint as sale_qty,
      sum(case when f.doc_type = 'Возврат' then coalesce(f.quantity, 0) else 0 end)::bigint as return_qty,
      sum(case when f.doc_type = 'Возврат' then -coalesce(f.amount, 0) else coalesce(f.amount, 0) end) as revenue,
      sum(case when f.doc_type = 'Возврат' then -coalesce(f.for_pay, 0) else coalesce(f.for_pay, 0) end) as for_pay,
      sum(case when f.doc_type = 'Возврат' then -coalesce(f.commission, 0) else coalesce(f.commission, 0) end) as commission,
      sum(coalesce(f.acquiring_fee, 0)) as acquiring,
      sum(coalesce(f.logistics, 0) - coalesce(f.rebill_logistic, 0)) as logistics,
      sum(coalesce(f.storage_fee, 0)) as storage_fin,
      sum(coalesce(f.acceptance, 0)) as acceptance_fin,
      sum(coalesce(f.penalty, 0)) as penalty,
      sum(coalesce(f.deduction, 0)) as deduction
    from raw_finance_report f
    where f.store_id = p_store
      and coalesce((f.sale_dt at time zone 'UTC')::date, f.rr_dt, f.period_start)
          between p_from and p_to
    group by 1
  ),
  st as (
    select s.nm_id as nm, sum(coalesce(s.warehouse_price, 0)) as storage
    from raw_storage_daily s
    where s.store_id = p_store and s.stat_date between p_from and p_to
    group by 1
  ),
  acc as (
    select coalesce(a.nm_id, 0) as nm, sum(coalesce(a.total, 0)) as acceptance
    from raw_acceptance a
    where a.store_id = p_store and a.gi_create_date between p_from and p_to
    group by 1
  ),
  adv as (
    select coalesce(r.nm_id, 0) as nm,
      sum(coalesce(r.sum, 0)) as advert,
      sum(coalesce(r.views, 0))::bigint as views,
      sum(coalesce(r.clicks, 0))::bigint as clicks
    from raw_advert_daily r
    where r.store_id = p_store and r.stat_date between p_from and p_to
    group by 1
  ),
  keys as (
    select nm from fin
    union select nm from st
    union select nm from acc
    union select nm from adv
  )
  select
    k.nm,
    coalesce(f.sale_qty, 0),
    coalesce(f.return_qty, 0),
    coalesce(f.revenue, 0),
    coalesce(f.for_pay, 0),
    coalesce(f.commission, 0),
    coalesce(f.acquiring, 0),
    coalesce(f.logistics, 0),
    coalesce(f.storage_fin, 0),
    coalesce(s.storage, 0),
    coalesce(f.acceptance_fin, 0),
    coalesce(a.acceptance, 0),
    coalesce(f.penalty, 0),
    coalesce(f.deduction, 0),
    coalesce(ad.advert, 0),
    coalesce(ad.views, 0),
    coalesce(ad.clicks, 0)
  from keys k
  left join fin f on f.nm = k.nm
  left join st s on s.nm = k.nm
  left join acc a on a.nm = k.nm
  left join adv ad on ad.nm = k.nm
  order by 1;
$$;

-- Помесячный финотчёт WB (ОПиУ, 0028)
create or replace function agg_wb_finance_monthly(p_store uuid, p_since date)
returns table(
  month date, revenue_rub numeric, for_pay_rub numeric, commission_rub numeric,
  acquiring_rub numeric, logistics_rub numeric, storage_rub numeric,
  penalty_rub numeric, acceptance_rub numeric, deduction_rub numeric,
  qty bigint, rows_count bigint, report_until date
)
language sql stable as $$
  select
    date_trunc('month', coalesce((sale_dt at time zone 'UTC')::date, rr_dt, period_start))::date,
    coalesce(sum(case when doc_type = 'Возврат' then -coalesce(amount, 0)
                      else coalesce(amount, 0) end), 0),
    coalesce(sum(case when doc_type = 'Возврат' then -coalesce(for_pay, 0)
                      else coalesce(for_pay, 0) end), 0),
    coalesce(sum(case when doc_type = 'Возврат' then -coalesce(commission, 0)
                      else coalesce(commission, 0) end), 0),
    coalesce(sum(coalesce(acquiring_fee, 0)), 0),
    coalesce(sum(coalesce(logistics, 0) - coalesce(rebill_logistic, 0)), 0),
    coalesce(sum(coalesce(storage_fee, 0)), 0),
    coalesce(sum(coalesce(penalty, 0)), 0),
    coalesce(sum(coalesce(acceptance, 0)), 0),
    coalesce(sum(coalesce(deduction, 0)), 0),
    coalesce(sum(case when doc_type = 'Возврат' then -coalesce(quantity, 0)
                      else coalesce(quantity, 0) end), 0)::bigint,
    count(*),
    max(rr_dt)
  from raw_finance_report
  where store_id = p_store
    and coalesce((sale_dt at time zone 'UTC')::date, rr_dt, period_start) >= p_since
  group by 1 order by 1;
$$;

-- Расшифровка удержаний по месяцам (ОПиУ)
create or replace function agg_deduction_details(p_store uuid, p_since date)
returns table(month date, oper_name text, amount_rub numeric)
language sql stable as $$
  select
    date_trunc('month', coalesce((f.sale_dt at time zone 'UTC')::date, f.rr_dt, f.period_start))::date,
    coalesce(nullif(trim(f.oper_name), ''), 'Прочее'),
    sum(coalesce(f.deduction, 0))
  from raw_finance_report f
  where f.store_id = p_store
    and coalesce(f.deduction, 0) <> 0
    and coalesce((f.sale_dt at time zone 'UTC')::date, f.rr_dt, f.period_start) >= p_since
  group by 1, 2
  having sum(coalesce(f.deduction, 0)) <> 0
  order by 1, 3 desc;
$$;
