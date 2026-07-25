-- ─────────────────────────────────────────────────────────────────────────────
-- 0023: Обязательный отчёт при закрытии задачи.
--   Требование клиента: нельзя закрыть задачу одним нажатием «Готово» — сотрудник
--   обязан написать, что реально сделано. Руководство (директор, ст. менеджеры)
--   видит эти отчёты и в вебе, и в Telegram.
--   Отчёт хранится прямо в tasks (одна задача = один финальный отчёт); переписка
--   по задаче — по-прежнему в task_comments.
-- ─────────────────────────────────────────────────────────────────────────────

alter table tasks
  add column completion_report text,                                  -- что сделано (обязателен при status='done')
  add column completed_at       timestamptz,
  add column completed_by       uuid references profiles(id) on delete set null,
  add column completed_on_time  boolean;                              -- закрыта до due_date (null — срока не было)

-- Отчёты руководству за период (страница «Отчёты», сводки бота)
create index idx_tasks_completed on tasks (org_id, completed_at desc)
  where completed_at is not null;

-- Инвариант: done ⇒ есть непустой отчёт. Ставится как NOT VALID, чтобы миграция
-- прошла на базе с уже закрытыми задачами (их закрывали до этого требования);
-- на все НОВЫЕ записи и обновления ограничение действует сразу.
alter table tasks
  add constraint tasks_done_requires_report
  check (status <> 'done' or (completion_report is not null and length(btrim(completion_report)) > 0))
  not valid;
