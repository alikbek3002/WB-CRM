-- 0035: юнит-экономика по товарам + расшифровка «прочих удержаний».
--
--   agg_unit_econ — все деньги по nm_id за период: реализация и удержания из
--   raw_finance_report (знаки как в 0028), хранение детально из
--   raw_storage_daily (в финотчёте оно почти всегда с nm_id=0), приёмка из
--   raw_acceptance, реклама из raw_advert_daily. Строки без товара
--   (nm_id 0/null) не выбрасываются — читающая сторона показывает их отдельной
--   строкой «нераспределённое», иначе сумма не сойдётся с ОПиУ.
--
--   agg_deduction_details — из чего складываются «прочие удержания» (deduction)
--   по месяцам и видам операций (самовыкупы, подмены и т.п.).

create index if not exists idx_raw_finance_store_nm
  on raw_finance_report (store_id, nm_id);

create function agg_unit_econ(p_store uuid, p_from date, p_to date)
returns table(
  nm_id bigint,
  sale_qty bigint,          -- продано, шт
  return_qty bigint,        -- возвраты, шт
  revenue_rub numeric,      -- реализация (продажи − возвраты)
  for_pay_rub numeric,      -- к перечислению продавцу
  commission_rub numeric,
  acquiring_rub numeric,
  logistics_rub numeric,    -- за вычетом возмещений
  storage_fin_rub numeric,  -- хранение по финотчёту (обычно на nm_id=0)
  storage_rub numeric,      -- хранение детально (raw_storage_daily)
  acceptance_fin_rub numeric,
  acceptance_rub numeric,   -- приёмка детально (raw_acceptance)
  penalty_rub numeric,
  deduction_rub numeric,
  advert_rub numeric,
  advert_views bigint,
  advert_clicks bigint
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
      and coalesce(f.sale_dt::date, f.rr_dt, f.period_start) between p_from and p_to
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

-- Расшифровка «прочих удержаний» по видам операций (месяц — как в 0028,
-- по дате продажи с фолбэком на дату расчёта, чтобы билось с ОПиУ)
create function agg_deduction_details(p_store uuid, p_since date)
returns table(month date, oper_name text, amount_rub numeric)
language sql stable as $$
  select
    date_trunc('month', coalesce(f.sale_dt::date, f.rr_dt, f.period_start))::date,
    coalesce(nullif(trim(f.oper_name), ''), 'Прочее'),
    sum(coalesce(f.deduction, 0))
  from raw_finance_report f
  where f.store_id = p_store
    and coalesce(f.deduction, 0) <> 0
    and coalesce(f.sale_dt::date, f.rr_dt, f.period_start) >= p_since
  group by 1, 2
  having sum(coalesce(f.deduction, 0)) <> 0
  order by 1, 3 desc;
$$;
