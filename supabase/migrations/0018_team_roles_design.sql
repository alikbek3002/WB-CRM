-- ─────────────────────────────────────────────────────────────────────────────
-- 0018: Реальная команда — роли по специализациям + модуль «Дизайн».
--   1) Расширение member_role: дизайнер, SEO, КИЗы, реклама, отгрузки.
--   2) design_requests — заявки на дизайн карточек: менеджер пишет товар и
--      референсы → дизайнер сдаёт макет → директор/ст. менеджер утверждает.
-- ─────────────────────────────────────────────────────────────────────────────

alter type member_role add value if not exists 'designer';  -- дизайнер (Феликс)
alter type member_role add value if not exists 'seo';       -- SEO-менеджер (Назира)
alter type member_role add value if not exists 'kiz';       -- менеджер по КИЗам (Жазгул)
alter type member_role add value if not exists 'adv';       -- менеджер по внутренней рекламе
alter type member_role add value if not exists 'shipping';  -- менеджер по отгрузкам на склады WB

create table design_requests (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  product_id     uuid references products(id) on delete set null,
  title          text not null,            -- какой товар / что нужно
  brief          text,                     -- задача: слайды, обложка, RICH…
  references_text text,                    -- референсы: ссылки, примеры, пожелания
  status         text not null default 'new'
                 check (status in ('new','in_progress','review','done','rejected')),
  requester_id   uuid references profiles(id) on delete set null,
  assignee_id    uuid references profiles(id) on delete set null, -- дизайнер
  result_url     text,                     -- ссылка на макет (Figma/диск)
  result_comment text,                     -- комментарий дизайнера к сдаче
  review_comment text,                     -- комментарий утверждающего
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_design_requests_org on design_requests (org_id, status, created_at desc);

create trigger trg_design_requests_updated_at
  before update on design_requests
  for each row execute function set_updated_at();

alter table design_requests enable row level security;

create policy design_requests_read on design_requests
  for select using (org_id in (select auth_org_ids()));
create policy design_requests_write on design_requests
  for all using (auth_role(org_id) in ('owner','admin','manager'));
