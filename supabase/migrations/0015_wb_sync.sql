-- ─────────────────────────────────────────────────────────────────────────────
-- 0015: Синхронизация с Wildberries API — контент карточки на товаре.
--   products: описание, галерея фото, цены WB (до/после скидки продавца).
--   integration_credentials: vault_secret_id опционален (MVP — токен в env,
--   Vault подключим отдельной фазой; статус/скоупы храним в этой таблице).
-- ─────────────────────────────────────────────────────────────────────────────

alter table products add column description          text;
alter table products add column photos               jsonb;          -- массив URL фото (big)
alter table products add column price_wb             numeric(12,2);  -- цена до скидки
alter table products add column price_discounted_wb  numeric(12,2);  -- цена со скидкой продавца

alter table integration_credentials alter column vault_secret_id drop not null;

-- Курсор инкрементальной синхронизации: WB отдаёт максимум 80 000 строк за запрос,
-- продолжение — с max(lastChangeDate) уже сохранённых строк.
alter table raw_orders add column last_change_date timestamptz;
alter table raw_sales  add column last_change_date timestamptz;
create index idx_raw_orders_lcd on raw_orders (store_id, last_change_date desc);
create index idx_raw_sales_lcd  on raw_sales  (store_id, last_change_date desc);
