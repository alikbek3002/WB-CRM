-- ─────────────────────────────────────────────────────────────────────────────
-- 0019: Скорость заказов по складам — для «хватит на N дней» в разрезе склада.
--   Заказ WB несёт склад отгрузки (raw_orders.warehouse): скорость склада =
--   заказы за период / дней. Runway склада = остаток на складе / скорость.
-- ─────────────────────────────────────────────────────────────────────────────

-- Заказы конкретного товара по складам за период
create or replace function agg_product_orders_by_warehouse(
  p_store uuid, p_nm bigint, p_since timestamptz
)
returns table(warehouse text, cnt bigint)
language sql stable as $$
  select warehouse, count(*)
  from raw_orders
  where store_id = p_store and nm_id = p_nm and order_date >= p_since
    and not coalesce(is_cancel, false) and warehouse is not null
  group by 1;
$$;

-- Заказы всех товаров по складам за период (обзор складов)
create or replace function agg_orders_by_warehouse(p_store uuid, p_since timestamptz)
returns table(warehouse text, cnt bigint)
language sql stable as $$
  select warehouse, count(*)
  from raw_orders
  where store_id = p_store and order_date >= p_since
    and not coalesce(is_cancel, false) and warehouse is not null
  group by 1;
$$;
