-- ─────────────────────────────────────────────────────────────────────────────
-- 0027: Рекламная статистика — расширяем числовые поля.
--   Первый же синк упал на «numeric field overflow»: WB отдаёт по кампаниям с
--   единичными показами конверсии и CPC, не помещающиеся в numeric(6,3) —
--   например cr = 100.000 при одном клике и одном заказе, а cpc растёт до тысяч.
--   Ширины подняты с запасом.
--
--   Витрина mv_rnp_advert_fact зависит от колонки sum, поэтому её приходится
--   пересоздать (определение — как в 0010, без изменений).
-- ─────────────────────────────────────────────────────────────────────────────

drop materialized view if exists mv_rnp_advert_fact;

alter table raw_advert_daily
  alter column ctr type numeric(12,3),
  alter column cpc type numeric(16,4),
  alter column cr  type numeric(12,3),
  alter column sum type numeric(16,2);

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

revoke all on mv_rnp_advert_fact from anon, authenticated;

-- Расход на рекламу по месяцам: строки с разбивкой по товарам и агрегаты
-- кампаний (nm_id = 0) в сумме дают полный расход — WB отдаёт либо одно,
-- либо другое, поэтому двойного счёта здесь нет.
create or replace function agg_advert_monthly(p_store uuid, p_since date)
returns table(month date, spend_rub numeric)
language sql stable as $$
  select date_trunc('month', stat_date)::date, coalesce(sum(sum), 0)
  from raw_advert_daily
  where store_id = p_store and stat_date >= p_since
  group by 1 order by 1;
$$;
