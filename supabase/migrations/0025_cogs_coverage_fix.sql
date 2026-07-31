-- ─────────────────────────────────────────────────────────────────────────────
-- 0025: Честное покрытие себестоимостью в ОПиУ.
--   В 0024 «заполненной» считалась любая непустая cost_price, но в реальной базе
--   у 307 из 308 товаров она равна НУЛЮ (карточки заведены синком WB, цифру ещё
--   не вносили). Из-за этого ОПиУ показывал покрытие 100% при нулевой
--   себестоимости — то есть завышенную прибыль без единого предупреждения.
--   Теперь заполненной считается только положительная себестоимость.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function agg_cogs_monthly(p_store uuid, p_since timestamptz)
returns table(month date, cogs_rub numeric, covered_qty bigint, total_qty bigint)
language sql stable as $$
  select
    date_trunc('month', s.sale_date)::date,
    coalesce(sum(case when coalesce(s.is_return, false)
                      then -coalesce(p.cost_price, 0)
                      else  coalesce(p.cost_price, 0) end), 0),
    count(*) filter (where coalesce(p.cost_price, 0) > 0
                       and not coalesce(s.is_return, false)),
    count(*) filter (where not coalesce(s.is_return, false))
  from raw_sales s
  left join products p on p.nm_id = s.nm_id and p.store_id = s.store_id
  where s.store_id = p_store and s.sale_date >= p_since
  group by 1 order by 1;
$$;
