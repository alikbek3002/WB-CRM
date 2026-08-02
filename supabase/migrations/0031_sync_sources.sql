-- 0031: расширение списка источников sync_runs.
-- Старый CHECK (0007) не знал 'wb-payouts'/'balance'/'aggregates' — их insert в
-- sync_runs молча падал (runSource не проверял error), и прогоны не логировались.
-- Плюс новые источники WB API: поставки FBW, платное хранение, платная приёмка,
-- тарифы (funnel уже был в списке с 0007).

alter table sync_runs drop constraint sync_runs_source_check;
alter table sync_runs add constraint sync_runs_source_check check (
  source in (
    'orders', 'sales', 'stocks', 'cards', 'funnel', 'advert', 'finance',
    'wb-payouts', 'balance', 'aggregates',
    'incomes', 'storage', 'acceptance', 'tariffs'
  )
);
