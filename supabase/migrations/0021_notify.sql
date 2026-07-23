-- ─────────────────────────────────────────────────────────────────────────────
-- 0021: Отметки Telegram-уведомлений по задачам регламента.
--   notified_at — утренняя отправка «задачи на сегодня» (не слать дважды);
--   reminded_at — напоминание за час до дедлайна (однократно).
-- ─────────────────────────────────────────────────────────────────────────────

alter table duty_assignments add column notified_at timestamptz;
alter table duty_assignments add column reminded_at timestamptz;
