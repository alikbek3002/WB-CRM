-- WB CRM · Миграция 0010: индексы и витрины (разделы 4 и 6 плана)

------------------------------------------------------------------------------
-- Индексы (обязательные по разделу 4 + для RLS-производительности)
------------------------------------------------------------------------------

create index idx_org_members_user      on org_members (user_id);
create index idx_invites_org           on invites (org_id);
create index idx_stores_org            on stores (org_id);
create index idx_credentials_store     on integration_credentials (store_id);
create index idx_product_groups_org    on product_groups (org_id);

create index idx_products_store        on products (store_id);
create index idx_products_group        on products (group_id);
create index idx_products_responsible  on products (responsible_user_id);

create index idx_stock_product_date    on stock_snapshots (product_id, snapshot_date);
create index idx_stock_date            on stock_snapshots (snapshot_date);

create index idx_raw_orders_store_date on raw_orders (store_id, order_date);
create index idx_raw_orders_store_nm   on raw_orders (store_id, nm_id);
create index idx_raw_sales_store_date  on raw_sales (store_id, sale_date);
create index idx_raw_sales_store_nm    on raw_sales (store_id, nm_id);
create index idx_raw_funnel_date       on raw_funnel_daily (store_id, stat_date);
create index idx_raw_advert_store_nm   on raw_advert_daily (store_id, nm_id, stat_date);
create index idx_raw_advert_date       on raw_advert_daily (store_id, stat_date);
create index idx_raw_finance_period    on raw_finance_report (store_id, period_start);

create index idx_rnp_plans_responsible on rnp_plans (responsible_user_id);

create index idx_tasks_org_status      on tasks (org_id, status);
create index idx_tasks_assignee        on tasks (assignee_id);
create index idx_tasks_product         on tasks (product_id);
create index idx_tasks_due             on tasks (due_date);
create index idx_task_comments_task    on task_comments (task_id);

create index idx_ai_insights_org_scope on ai_insights (org_id, scope, created_at desc);
create index idx_ai_insights_hash      on ai_insights (prompt_hash);
create index idx_sync_runs_store       on sync_runs (store_id, source, started_at desc);
create index idx_audit_log_org         on audit_log (org_id, created_at desc);

------------------------------------------------------------------------------
-- Витрины факта РНП (раздел 6 плана). Обновляются после каждой синхронизации
-- через refresh_rnp_views(). Materialized views не поддерживают RLS,
-- поэтому доступ к ним закрыт: читаем только через сервисный слой (service_role).
------------------------------------------------------------------------------

-- Факт заказов по SKU/неделе
create materialized view mv_rnp_fact as
select
  p.id as product_id,
  p.store_id,
  extract(isoyear from o.order_date)::smallint as iso_year,
  extract(week    from o.order_date)::smallint as iso_week,
  count(*) filter (where not o.is_cancel)          as fact_orders,
  sum(o.price) filter (where not o.is_cancel)      as fact_orders_sum,
  avg(o.spp_percent)                               as avg_spp
from products p
join raw_orders o on o.store_id = p.store_id and o.nm_id = p.nm_id
group by 1,2,3,4;

create unique index idx_mv_rnp_fact on mv_rnp_fact (product_id, iso_year, iso_week);

-- Факт продаж/выкупов по SKU/неделе
create materialized view mv_rnp_sales_fact as
select
  p.id as product_id,
  p.store_id,
  extract(isoyear from s.sale_date)::smallint as iso_year,
  extract(week    from s.sale_date)::smallint as iso_week,
  count(*) filter (where not s.is_return)                 as fact_sales,
  sum(s.for_pay) filter (where not s.is_return)           as fact_sales_sum,
  sum(s.price_with_disc) filter (where not s.is_return)   as fact_sales_sum_disc,
  avg(s.spp_percent)                                      as avg_spp
from products p
join raw_sales s on s.store_id = p.store_id and s.nm_id = p.nm_id
group by 1,2,3,4;

create unique index idx_mv_rnp_sales_fact on mv_rnp_sales_fact (product_id, iso_year, iso_week);

-- Воронка по SKU/неделе (переходы, корзина, конверсии — раздел 6)
create materialized view mv_rnp_funnel_fact as
select
  p.id as product_id,
  p.store_id,
  extract(isoyear from f.stat_date)::smallint as iso_year,
  extract(week    from f.stat_date)::smallint as iso_week,
  sum(f.open_card_count)    as open_cards,
  sum(f.add_to_cart_count)  as carts,
  sum(f.orders_count)       as orders,
  sum(f.orders_sum_rub)     as orders_sum,
  sum(f.buyouts_count)      as buyouts,
  sum(f.buyouts_sum_rub)    as buyouts_sum,
  case when sum(f.open_card_count) > 0
       then round(100.0 * sum(f.add_to_cart_count) / sum(f.open_card_count), 2) end as cart_percent,
  case when sum(f.add_to_cart_count) > 0
       then round(100.0 * sum(f.orders_count) / sum(f.add_to_cart_count), 2) end as order_percent,
  case when sum(f.open_card_count) > 0
       then round(100.0 * sum(f.orders_count) / sum(f.open_card_count), 2) end as cro_percent
from products p
join raw_funnel_daily f on f.store_id = p.store_id and f.nm_id = p.nm_id
group by 1,2,3,4;

create unique index idx_mv_rnp_funnel_fact on mv_rnp_funnel_fact (product_id, iso_year, iso_week);

-- Реклама по SKU/неделе (показы, клики, CTR, расход, ДРР считается в слое API)
create materialized view mv_rnp_advert_fact as
select
  p.id as product_id,
  p.store_id,
  extract(isoyear from a.stat_date)::smallint as iso_year,
  extract(week    from a.stat_date)::smallint as iso_week,
  sum(a.views)  as views,
  sum(a.clicks) as clicks,
  sum(a.sum)    as ad_spend,
  case when sum(a.views) > 0
       then round(100.0 * sum(a.clicks) / sum(a.views), 3) end as ctr
from products p
join raw_advert_daily a on a.store_id = p.store_id and a.nm_id = p.nm_id
group by 1,2,3,4;

create unique index idx_mv_rnp_advert_fact on mv_rnp_advert_fact (product_id, iso_year, iso_week);

-- Витрины читает только сервисный слой
revoke all on mv_rnp_fact, mv_rnp_sales_fact, mv_rnp_funnel_fact, mv_rnp_advert_fact
  from anon, authenticated;

-- Обновление витрин после синка (вызывается воркером, раздел 8)
create or replace function refresh_rnp_views()
returns void language plpgsql security definer set search_path = public as $$
begin
  refresh materialized view concurrently mv_rnp_fact;
  refresh materialized view concurrently mv_rnp_sales_fact;
  refresh materialized view concurrently mv_rnp_funnel_fact;
  refresh materialized view concurrently mv_rnp_advert_fact;
end;
$$;

revoke execute on function refresh_rnp_views() from anon, authenticated;
