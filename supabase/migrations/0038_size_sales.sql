-- ─────────────────────────────────────────────────────────────────────────────
-- 0038: «На сколько хватит» по размерам в карточке товара.
--   Продажа WB несёт размер (techSize), но синк его не сохранял — добавляем
--   колонку. Скорость размера = продажи размера за 30 дней / 30; runway
--   размера = остаток размера / скорость (та же формула, что daysOfCover
--   товара целиком). Историю добивает scripts/backfill-sales-sizes.ts
--   (повторная выгрузка /supplier/sales, upsert по store_id+srid+sale_id).
-- ─────────────────────────────────────────────────────────────────────────────

alter table raw_sales add column if not exists tech_size text;

-- Продажи по размерам за период. tech_size is null — строки, синхронизированные
-- до 0038 и ещё не добитые бэкфиллом: их в разбивку не берём, иначе вся старая
-- история повиснет ложным «б/р».
create or replace function agg_sales_by_size(p_store uuid, p_since timestamptz)
returns table(nm_id bigint, size text, cnt bigint)
language sql stable as $$
  select nm_id, tech_size, count(*)
  from raw_sales
  where store_id = p_store and sale_date >= p_since
    and not coalesce(is_return, false)
    and tech_size is not null
  group by 1, 2;
$$;

-- Покрывающий частичный индекс — Index Only Scan без похода в кучу (урок 0036);
-- возвраты в индекс не попадают вовсе.
create index if not exists idx_raw_sales_size_agg
  on raw_sales (store_id, sale_date) include (nm_id, tech_size)
  where not coalesce(is_return, false);

-- Карта видимости для Index Only Scan: синк почти только вставляет, обычный
-- порог autovacuum не срабатывает — освежаем vacuum по вставкам (как
-- raw_orders и raw_finance_report в 0036).
alter table raw_sales set (
  autovacuum_vacuum_insert_scale_factor = 0.05,
  autovacuum_vacuum_insert_threshold = 20000
);
