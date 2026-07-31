-- ─────────────────────────────────────────────────────────────────────────────
-- 0026: Финансы Wildberries из API + кэш месячных агрегатов.
--
--   1) raw_finance_report расширен под реальный ответ v5/reportDetailByPeriod:
--      к перечислению, эквайринг, приёмка, удержания, возвраты логистики,
--      тип операции и валюта отчёта. Без них ОПиУ считался эвристикой
--      (выручка − for_pay), теперь берём фактические удержания WB.
--
--   2) wb_balance — баланс кабинета (finance-api/account/balance): деньги,
--      которые WB ещё должен продавцу. Показываем в «Кассе» отдельным счётом.
--
--   3) Кэш месячных продаж agg_sales_month: ОПиУ за 6 месяцев считался по
--      raw_sales (сотни тысяч строк) 6+ секунд. Теперь агрегируем один раз за
--      синк в компактную таблицу (~товары × месяцы), читающие функции переводим
--      на неё БЕЗ смены сигнатур — код приложения не меняется.
-- ─────────────────────────────────────────────────────────────────────────────

set statement_timeout = '600s';

------------------------------------------------------------------------------
-- 1. Детализация отчёта о реализации (v5) — недостающие поля
------------------------------------------------------------------------------

alter table raw_finance_report
  add column if not exists realizationreport_id bigint,
  add column if not exists currency_name    text,            -- валюта отчёта (кабинет может считать не в ₽)
  add column if not exists oper_name        text,            -- supplier_oper_name: «Продажа», «Логистика»…
  add column if not exists quantity         integer,
  add column if not exists retail_price     numeric(14,2),   -- цена розничная
  add column if not exists for_pay          numeric(14,2),   -- ppvz_for_pay — к перечислению продавцу
  add column if not exists acquiring_fee    numeric(14,2),   -- эквайринг
  add column if not exists acceptance       numeric(14,2),   -- платная приёмка
  add column if not exists deduction        numeric(14,2),   -- прочие удержания (может быть отрицательным)
  add column if not exists rebill_logistic  numeric(14,2),   -- возмещение логистики
  add column if not exists rr_dt            date,            -- дата расчёта (по ней WB считает период)
  add column if not exists sale_dt          timestamptz;

-- Отчёт читается по дате расчёта и по магазину
create index if not exists idx_raw_finance_store_rrdt on raw_finance_report (store_id, rr_dt);

------------------------------------------------------------------------------
-- 2. Баланс кабинета WB
------------------------------------------------------------------------------

create table if not exists wb_balance (
  store_id     uuid primary key references stores(id) on delete cascade,
  currency     text not null default 'RUB',
  current_amount numeric(14,2) not null default 0,  -- на балансе
  for_withdraw   numeric(14,2) not null default 0,  -- доступно к выводу
  checked_at   timestamptz not null default now()
);

alter table wb_balance enable row level security;
create policy "wb_balance: read own org" on wb_balance
  for select using (store_org(store_id) in (select auth_org_ids()));

------------------------------------------------------------------------------
-- 3. Кэш месячных продаж (по товарам) — основа быстрого ОПиУ
--    Возвраты держим отдельными колонками: в ОПиУ они уменьшают выручку.
------------------------------------------------------------------------------

create table if not exists agg_sales_month (
  store_id       uuid   not null references stores(id) on delete cascade,
  nm_id          bigint not null,
  month          date   not null,               -- первое число месяца
  qty            bigint  not null default 0,    -- продано, шт
  revenue        numeric not null default 0,    -- сумма продаж (price_with_disc)
  for_pay        numeric not null default 0,    -- к перечислению по продажам
  returns_qty    bigint  not null default 0,
  returns_amount numeric not null default 0,
  returns_for_pay numeric not null default 0,
  primary key (store_id, nm_id, month)
);

create index if not exists idx_agg_sales_month_store on agg_sales_month (store_id, month);

alter table agg_sales_month enable row level security;

-- Пересчёт последних p_months месяцев (старые месяцы WB уже не меняет).
-- Вызывается синком после загрузки продаж.
create or replace function refresh_sales_month(p_store uuid, p_months int default 3)
returns int
language plpgsql volatile as $$
declare
  v_since date := date_trunc('month', current_date - (p_months || ' months')::interval)::date;
  v_rows  int;
begin
  delete from agg_sales_month where store_id = p_store and month >= v_since;

  insert into agg_sales_month
    (store_id, nm_id, month, qty, revenue, for_pay,
     returns_qty, returns_amount, returns_for_pay)
  select
    p_store,
    nm_id,
    date_trunc('month', sale_date)::date,
    count(*) filter (where not coalesce(is_return, false)),
    coalesce(sum(price_with_disc) filter (where not coalesce(is_return, false)), 0),
    coalesce(sum(for_pay)         filter (where not coalesce(is_return, false)), 0),
    count(*) filter (where coalesce(is_return, false)),
    coalesce(sum(price_with_disc) filter (where coalesce(is_return, false)), 0),
    coalesce(sum(for_pay)         filter (where coalesce(is_return, false)), 0)
  from raw_sales
  where store_id = p_store and sale_date >= v_since and nm_id is not null
  group by 1, 2, 3;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

------------------------------------------------------------------------------
-- 4. Читающие функции ОПиУ → на кэш (сигнатуры прежние)
--    Возвраты WB отдаёт отдельными строками; в отчётности они уменьшают
--    выручку и количество — поэтому вычитаем, а не игнорируем.
------------------------------------------------------------------------------

create or replace function agg_sales_monthly(p_store uuid, p_since timestamptz)
returns table(month date, qty bigint, revenue_rub numeric, for_pay_rub numeric)
language sql stable as $$
  select
    month,
    sum(qty) - sum(returns_qty),
    coalesce(sum(revenue) - sum(returns_amount), 0),
    coalesce(sum(for_pay) - sum(returns_for_pay), 0)
  from agg_sales_month
  where store_id = p_store and month >= date_trunc('month', p_since)::date
  group by 1 order by 1;
$$;

-- Себестоимость проданного: кэш продаж × cost_price товара.
-- Себестоимость правят руками в любой момент, поэтому в кэш её не кладём —
-- join по 300 товарам стоит доли миллисекунды.
create or replace function agg_cogs_monthly(p_store uuid, p_since timestamptz)
returns table(month date, cogs_rub numeric, covered_qty bigint, total_qty bigint)
language sql stable as $$
  select
    s.month,
    coalesce(sum((s.qty - s.returns_qty) * coalesce(p.cost_price, 0)), 0),
    coalesce(sum(s.qty) filter (where coalesce(p.cost_price, 0) > 0), 0),
    coalesce(sum(s.qty), 0)
  from agg_sales_month s
  left join products p on p.nm_id = s.nm_id and p.store_id = s.store_id
  where s.store_id = p_store and s.month >= date_trunc('month', p_since)::date
  group by 1 order by 1;
$$;

------------------------------------------------------------------------------
-- 5. Удержания WB по месяцам — из отчёта о реализации (по дате расчёта).
--    Возвраты (doc_type_name = 'Возврат') уменьшают выручку и к перечислению.
------------------------------------------------------------------------------

create or replace function agg_wb_finance_monthly(p_store uuid, p_since date)
returns table(
  month date,
  revenue_rub numeric,      -- реализация (продажи − возвраты)
  for_pay_rub numeric,      -- к перечислению продавцу
  commission_rub numeric,   -- комиссия WB
  acquiring_rub numeric,    -- эквайринг
  logistics_rub numeric,    -- логистика (за вычетом возмещений)
  storage_rub numeric,      -- хранение
  penalty_rub numeric,      -- штрафы
  acceptance_rub numeric,   -- платная приёмка
  deduction_rub numeric,    -- прочие удержания
  qty bigint,
  rows_count bigint
)
language sql stable as $$
  select
    date_trunc('month', coalesce(rr_dt, period_start))::date,
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
    count(*)
  from raw_finance_report
  where store_id = p_store
    and coalesce(rr_dt, period_start) >= p_since
  group by 1 order by 1;
$$;

------------------------------------------------------------------------------
-- 6. Статьи расходов, которые теперь приходят из API, — в архив.
--    Логистику, хранение, штрафы и рекламу WB больше не вносят руками:
--    они уже в отчёте реализации и в статистике кампаний. Иначе двойной счёт.
--    Взамен — статья для внешней рекламы (блогеры, таргет вне WB).
------------------------------------------------------------------------------

update expense_categories
   set archived = true
 where name in ('Логистика WB', 'Хранение WB', 'Штрафы WB', 'Реклама WB')
   and not exists (
     select 1 from cash_tx t where t.category_id = expense_categories.id
   );

insert into expense_categories (org_id, name, direction, in_pnl, emoji, sort_order)
select o.id, c.name, c.direction, c.in_pnl, c.emoji, c.sort_order
from orgs o
cross join (values
  ('Внешняя реклама', 'out', true, '📣', 10),
  ('Блогеры и обзоры', 'out', true, '🎥', 15)
) as c(name, direction, in_pnl, emoji, sort_order)
on conflict (org_id, name) do nothing;
