-- ─────────────────────────────────────────────────────────────────────────────
-- 0016: Агрегатные функции чтения.
--   С реальными объёмами WB (~200 тыс. заказов/мес) тянуть сырые строки в Node
--   нельзя: PostgREST молча режет выборку до 1000 строк (max-rows) — числа врут.
--   Агрегируем в Postgres, наружу отдаём готовые срезы.
-- ─────────────────────────────────────────────────────────────────────────────

-- Заказы по дням (не отменённые)
create or replace function agg_orders_daily(p_store uuid, p_since timestamptz)
returns table(day date, qty bigint, sum_rub numeric)
language sql stable as $$
  select order_date::date, count(*), coalesce(sum(price), 0)
  from raw_orders
  where store_id = p_store and order_date >= p_since
    and not coalesce(is_cancel, false)
  group by 1 order by 1;
$$;

-- Продажи: итог за период (выкупы без возвратов)
create or replace function agg_sales_summary(p_store uuid, p_since timestamptz)
returns table(qty bigint, sum_rub numeric)
language sql stable as $$
  select count(*), coalesce(sum(for_pay), 0)
  from raw_sales
  where store_id = p_store and sale_date >= p_since
    and not coalesce(is_return, false);
$$;

-- Продажи по артикулам за период (для скорости продаж товара)
create or replace function agg_sales_by_nm(p_store uuid, p_since timestamptz)
returns table(nm_id bigint, cnt bigint)
language sql stable as $$
  select nm_id, count(*)
  from raw_sales
  where store_id = p_store and sale_date >= p_since
    and not coalesce(is_return, false)
  group by 1;
$$;

-- Остатки по складам (последний общий снимок; служебный «В пути (WB)» не входит —
-- у него on_stock = 0)
create or replace function agg_stock_by_warehouse(p_store uuid)
returns table(warehouse text, qty bigint)
language sql stable as $$
  with latest as (
    select max(ss.snapshot_date) as d
    from stock_snapshots ss join products p on p.id = ss.product_id
    where p.store_id = p_store
  )
  select ss.warehouse, sum(ss.on_stock)
  from stock_snapshots ss
  join products p on p.id = ss.product_id
  where p.store_id = p_store and ss.snapshot_date = (select d from latest)
  group by 1
  having sum(ss.on_stock) > 0
  order by 2 desc;
$$;

-- Остаток по каждому товару (последний снимок КАЖДОГО товара)
create or replace function agg_stock_by_product(p_store uuid)
returns table(product_id uuid, on_stock bigint, in_transit bigint)
language sql stable as $$
  with latest as (
    select ss.product_id as pid, max(ss.snapshot_date) as d
    from stock_snapshots ss join products p on p.id = ss.product_id
    where p.store_id = p_store
    group by 1
  )
  select ss.product_id, sum(ss.on_stock), sum(ss.in_transit)
  from stock_snapshots ss
  join latest l on l.pid = ss.product_id and l.d = ss.snapshot_date
  group by 1;
$$;

-- Размерная сетка остатков товара (последний снимок товара) — для РНП
create or replace function agg_stock_sizes(p_store uuid)
returns table(product_id uuid, size text, on_stock bigint, in_transit bigint, in_production bigint)
language sql stable as $$
  with latest as (
    select ss.product_id as pid, max(ss.snapshot_date) as d
    from stock_snapshots ss join products p on p.id = ss.product_id
    where p.store_id = p_store
    group by 1
  )
  select ss.product_id, ss.size, sum(ss.on_stock), sum(ss.in_transit), sum(ss.in_production)
  from stock_snapshots ss
  join latest l on l.pid = ss.product_id and l.d = ss.snapshot_date
  group by 1, 2;
$$;

-- РНП: дневные агрегаты заказов/продаж по артикулу
create or replace function agg_rnp_daily(p_store uuid, p_since timestamptz)
returns table(
  nm_id bigint, day date,
  orders_qty bigint, orders_sum numeric,
  sales_qty bigint, sales_sum numeric,
  spp_avg numeric
)
language sql stable as $$
  with o as (
    select nm_id, order_date::date as d, count(*) as oq,
           coalesce(sum(price), 0) as osum, avg(coalesce(spp_percent, 0)) as spp
    from raw_orders
    where store_id = p_store and order_date >= p_since
      and not coalesce(is_cancel, false)
    group by 1, 2
  ), s as (
    select nm_id, sale_date::date as d, count(*) as sq,
           coalesce(sum(price_with_disc), 0) as ssum
    from raw_sales
    where store_id = p_store and sale_date >= p_since
      and not coalesce(is_return, false)
    group by 1, 2
  )
  select coalesce(o.nm_id, s.nm_id), coalesce(o.d, s.d),
         coalesce(o.oq, 0), coalesce(o.osum, 0),
         coalesce(s.sq, 0), coalesce(s.ssum, 0), coalesce(o.spp, 0)
  from o full outer join s on s.nm_id = o.nm_id and s.d = o.d;
$$;
