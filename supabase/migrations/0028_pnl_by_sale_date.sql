-- ─────────────────────────────────────────────────────────────────────────────
-- 0028: ОПиУ считаем по дате ПРОДАЖИ, а не по дате расчёта WB.
--
--   В 0026 удержания группировались по rr_dt (дата расчётного документа). Из-за
--   этого выручка в отчёте не билась с продажами: WB закрывает неделю с
--   задержкой, и часть июльских продаж попадала в «июнь» по дате расчёта.
--   Смотреть на такой ОПиУ нельзя — месяцы скачут.
--
--   Теперь всё сводится к месяцу продажи (sale_dt); строки без продажи
--   (логистика, хранение, удержания) остаются на дате расчёта. Дополнительно
--   возвращаем report_until — до какой даты WB реально посчитал: продажи после
--   неё ещё без удержаний, и интерфейс обязан это показать.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists idx_raw_finance_store_saledt
  on raw_finance_report (store_id, sale_dt);

-- Набор возвращаемых колонок изменился (добавился report_until) — пересоздаём
drop function if exists agg_wb_finance_monthly(uuid, date);

create function agg_wb_finance_monthly(p_store uuid, p_since date)
returns table(
  month date,
  revenue_rub numeric,      -- реализация по отчёту (продажи − возвраты)
  for_pay_rub numeric,      -- к перечислению продавцу
  commission_rub numeric,   -- комиссия WB
  acquiring_rub numeric,    -- эквайринг
  logistics_rub numeric,    -- логистика (за вычетом возмещений)
  storage_rub numeric,      -- хранение
  penalty_rub numeric,      -- штрафы
  acceptance_rub numeric,   -- платная приёмка
  deduction_rub numeric,    -- прочие удержания
  qty bigint,
  rows_count bigint,
  report_until date         -- по какую дату расчёта отчёт заполнен
)
language sql stable as $$
  select
    date_trunc('month', coalesce(sale_dt::date, rr_dt, period_start))::date,
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
    count(*),
    max(rr_dt)
  from raw_finance_report
  where store_id = p_store
    and coalesce(sale_dt::date, rr_dt, period_start) >= p_since
  group by 1 order by 1;
$$;
