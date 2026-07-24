-- ─────────────────────────────────────────────────────────────────────────────
-- 0022: Кэш дневных агрегатов заказов/продаж.
--   Проблема: agg_* по raw_orders (450 тыс. строк) = seq scan + агрегация ~10 с
--   на слабом CPU Supabase → statement timeout 8 с, медленные РНП/дашборд.
--   Решение: агрегируем ОДИН раз за синк в компактную таблицу (~5 тыс. строк),
--   читающие функции переводим на неё БЕЗ смены сигнатур (код приложения не
--   меняется). Обновление — refresh_agg_daily() из синка (окно 60 дней; более
--   старые дни заморожены — WB практически не меняет записи такой давности).
-- ─────────────────────────────────────────────────────────────────────────────

set statement_timeout = '300s';

create table agg_daily_cache (
  store_id         uuid   not null references stores(id) on delete cascade,
  nm_id            bigint not null,
  day              date   not null,
  orders_qty       bigint  not null default 0,
  orders_sum       numeric not null default 0, -- sum(price), без отменённых
  spp_sum          numeric not null default 0, -- sum(spp_percent) по заказам (для avg)
  sales_qty        bigint  not null default 0, -- выкупы без возвратов
  sales_sum_disc   numeric not null default 0, -- sum(price_with_disc) — «как в кабинете»
  sales_sum_forpay numeric not null default 0, -- sum(for_pay) — к перечислению
  primary key (store_id, nm_id, day)
);

create index idx_agg_daily_store_day on agg_daily_cache (store_id, day);

-- Только сервисные чтения (rpc под service_role, RLS обходится); прямых
-- клиентских селектов нет — политики не заводим.
alter table agg_daily_cache enable row level security;

-- Пересчёт окна последних p_days дней (вызывается синком после заказов/продаж)
create or replace function refresh_agg_daily(p_store uuid, p_days int default 60)
returns int
language plpgsql volatile as $$
declare
  v_since date := current_date - p_days;
  v_rows  int;
begin
  delete from agg_daily_cache where store_id = p_store and day >= v_since;

  insert into agg_daily_cache
    (store_id, nm_id, day, orders_qty, orders_sum, spp_sum,
     sales_qty, sales_sum_disc, sales_sum_forpay)
  select p_store, coalesce(o.nm_id, s.nm_id), coalesce(o.d, s.d),
         coalesce(o.oq, 0), coalesce(o.osum, 0), coalesce(o.spp_sum, 0),
         coalesce(s.sq, 0), coalesce(s.ssum_disc, 0), coalesce(s.ssum_forpay, 0)
  from (
    select nm_id, order_date::date as d, count(*) as oq,
           coalesce(sum(price), 0) as osum,
           coalesce(sum(coalesce(spp_percent, 0)), 0) as spp_sum
    from raw_orders
    where store_id = p_store and order_date >= v_since
      and not coalesce(is_cancel, false)
    group by 1, 2
  ) o
  full outer join (
    select nm_id, sale_date::date as d, count(*) as sq,
           coalesce(sum(price_with_disc), 0) as ssum_disc,
           coalesce(sum(for_pay), 0) as ssum_forpay
    from raw_sales
    where store_id = p_store and sale_date >= v_since
      and not coalesce(is_return, false)
    group by 1, 2
  ) s on s.nm_id = o.nm_id and s.d = o.d;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ── Читающие функции → кэш (сигнатуры прежние, код приложения не меняется) ──

create or replace function agg_orders_daily(p_store uuid, p_since timestamptz)
returns table(day date, qty bigint, sum_rub numeric)
language sql stable as $$
  select day, sum(orders_qty), coalesce(sum(orders_sum), 0)
  from agg_daily_cache
  where store_id = p_store and day >= p_since::date
  group by 1 having sum(orders_qty) > 0 order by 1;
$$;

create or replace function agg_sales_summary(p_store uuid, p_since timestamptz)
returns table(qty bigint, sum_rub numeric)
language sql stable as $$
  select coalesce(sum(sales_qty), 0), coalesce(sum(sales_sum_forpay), 0)
  from agg_daily_cache
  where store_id = p_store and day >= p_since::date;
$$;

create or replace function agg_sales_by_nm(p_store uuid, p_since timestamptz)
returns table(nm_id bigint, cnt bigint)
language sql stable as $$
  select nm_id, sum(sales_qty)
  from agg_daily_cache
  where store_id = p_store and day >= p_since::date
  group by 1 having sum(sales_qty) > 0;
$$;

create or replace function agg_sales_daily(p_store uuid, p_since timestamptz)
returns table(day date, qty bigint, sum_rub numeric)
language sql stable as $$
  select day, sum(sales_qty), coalesce(sum(sales_sum_disc), 0)
  from agg_daily_cache
  where store_id = p_store and day >= p_since::date
  group by 1 having sum(sales_qty) > 0 order by 1;
$$;

create or replace function agg_rnp_daily(p_store uuid, p_since timestamptz)
returns table(
  nm_id bigint, day date,
  orders_qty bigint, orders_sum numeric,
  sales_qty bigint, sales_sum numeric,
  spp_avg numeric
)
language sql stable as $$
  select nm_id, day, orders_qty, orders_sum, sales_qty, sales_sum_disc,
         case when orders_qty > 0 then spp_sum / orders_qty else 0 end
  from agg_daily_cache
  where store_id = p_store and day >= p_since::date;
$$;

-- ── Таймаут запросов service_role: 8 с (дефолт) → 60 с. Бэкенд ходит только
-- под service_role; refresh_agg_daily и редкие тяжёлые запросы перестают
-- обрываться. PostgREST подхватывает настройку роли после reload config.
alter role service_role set statement_timeout = '60s';
notify pgrst, 'reload config';

-- ── Первичное наполнение: вся история (только эта миграция, дальше — синк).
-- Прямое соединение psql — без 8-секундного лимита PostgREST.
do $$
declare
  r record;
begin
  for r in select distinct store_id from raw_orders loop
    perform refresh_agg_daily(r.store_id, 3650);
  end loop;
end $$;
