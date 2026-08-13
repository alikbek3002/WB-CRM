"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  Pencil,
  Plus,
  Repeat,
} from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Input } from "@/frontend/components/ui/input";
import { Label } from "@/frontend/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/frontend/components/ui/select";
import { cn } from "@/shared/utils";
import {
  DUTY_WEEKDAYS,
  OWN_DUTY_HINT,
  canEditDutyTemplate,
  isOwnDuty,
} from "@/shared/duties";
import { ROLE_LABELS, type MemberRole } from "@/shared/rbac";
import type { DutyTemplateItem } from "@/shared/types";

export type DutyMember = { id: string; name: string; role: string; roleLabel: string };
type Me = { userId: string; role: MemberRole };

// Кому назначена обязанность — одним значением для селекта: поимённо или на роль
const targetValue = (t: { assigneeUserId: string | null; role: string }) =>
  t.assigneeUserId ? `user:${t.assigneeUserId}` : `role:${t.role}`;

function targetFromValue(value: string): { assigneeUserId: string | null; role: string } {
  if (value.startsWith("user:")) return { assigneeUserId: value.slice(5), role: "" };
  return { assigneeUserId: null, role: value.slice(5) };
}

// ─── Форма обязанности ────────────────────────────────────────────────────────

function RuleDialog({
  template,
  members,
  me,
  defaultTarget,
  open,
  onOpenChange,
}: {
  template?: DutyTemplateItem;
  members: DutyMember[];
  me: Me;
  defaultTarget?: string; // «user:<id>» / «role:<role>» — когда добавляем с карточки сотрудника
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const memberById = new Map(members.map((m) => [m.id, m]));

  const [title, setTitle] = useState(template?.title ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [target, setTarget] = useState(
    template
      ? targetValue(template)
      : defaultTarget ?? (members[0] ? `user:${members[0].id}` : "role:manager"),
  );
  const [frequency, setFrequency] = useState<"daily" | "weekly">(
    template?.frequency ?? "daily",
  );
  const [weekday, setWeekday] = useState<number>(template?.weekday ?? 1);
  const [dueTime, setDueTime] = useState(template?.dueTime ?? "18:00");
  const [hours, setHours] = useState(String(template?.hoursToComplete ?? 3));
  const [requiresReport, setRequiresReport] = useState(template?.requiresReport ?? true);
  const [saving, setSaving] = useState(false);

  // Роль обязанности: при назначении поимённо берём роль сотрудника — по ней
  // ensureDutyAssignments раздаёт наряды, если имя потом уберут.
  const picked = targetFromValue(target);
  const role = picked.assigneeUserId
    ? memberById.get(picked.assigneeUserId)?.role ?? "manager"
    : picked.role;
  const wouldBeMine = isOwnDuty({ assigneeUserId: picked.assigneeUserId, role }, me);
  const forbidden = !canEditDutyTemplate(
    { assigneeUserId: picked.assigneeUserId, role },
    me,
  );

  async function save() {
    if (!title.trim()) return toast.error("Назовите обязанность");
    setSaving(true);
    try {
      const res = await fetch("/api/duties/templates", {
        method: template ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(template ? { id: template.id } : {}),
          title: title.trim(),
          description: description.trim() || null,
          role,
          assigneeUserId: picked.assigneeUserId,
          frequency,
          weekday: frequency === "weekly" ? weekday : null,
          dueTime,
          hoursToComplete: Number(hours) || 1,
          requiresReport,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error === "own_duty_forbidden"
            ? "Свой регламент правит только директор"
            : data?.error === "weekday_required"
              ? "Выберите день недели"
              : "Ошибка",
        );
      }
      toast.success(template ? "Обязанность обновлена" : "Обязанность добавлена");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {template ? `Обязанность · ${template.title}` : "Новая обязанность"}
          </DialogTitle>
          <DialogDescription>
            Из этой строки каждый день собирается задача сотруднику: с дедлайном,
            запасом времени и отчётом.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="rule-title">Что нужно делать</Label>
            <Input
              id="rule-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ответы на отзывы — ночные"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rule-desc">Как именно (регламент, чеклист)</Label>
            <textarea
              id="rule-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Разобрать отзывы с 20:00 прошлого дня, ответить по шаблонам, негатив — эскалировать в чат…"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Кто выполняет</Label>
            <Select value={target} onValueChange={(v) => v && setTarget(String(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.id} value={`user:${m.id}`}>
                    {m.name} · {m.roleLabel}
                  </SelectItem>
                ))}
                {[...new Set(members.map((m) => m.role))].map((r) => (
                  <SelectItem key={r} value={`role:${r}`}>
                    Все с ролью «{ROLE_LABELS[r as MemberRole] ?? r}»
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {forbidden && (
              <p className="text-xs text-amber-400">
                {wouldBeMine
                  ? "Это ваш регламент — назначать и править его может только директор."
                  : "Нет прав на эту обязанность."}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>Как часто</Label>
            <div className="flex flex-wrap gap-1">
              <Button
                size="xs"
                variant={frequency === "daily" ? "default" : "outline"}
                onClick={() => setFrequency("daily")}
              >
                Каждый день
              </Button>
              <Button
                size="xs"
                variant={frequency === "weekly" ? "default" : "outline"}
                onClick={() => setFrequency("weekly")}
              >
                Раз в неделю
              </Button>
            </div>
            {frequency === "weekly" && (
              <div className="flex flex-wrap gap-1 pt-1">
                {DUTY_WEEKDAYS.map((d) => (
                  <Button
                    key={d.value}
                    size="xs"
                    variant={weekday === d.value ? "default" : "outline"}
                    onClick={() => setWeekday(d.value)}
                  >
                    {d.short}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rule-due">Сделать до</Label>
              <Input
                id="rule-due"
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rule-hours">Часов на выполнение</Label>
              <Input
                id="rule-hours"
                type="number"
                min={1}
                max={24}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Отчёт о выполнении</Label>
            <div className="flex gap-1">
              <Button
                size="xs"
                variant={requiresReport ? "default" : "outline"}
                onClick={() => setRequiresReport(true)}
              >
                Обязателен
              </Button>
              <Button
                size="xs"
                variant={!requiresReport ? "default" : "outline"}
                onClick={() => setRequiresReport(false)}
              >
                Не нужен
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Отчёты видят директор и старший менеджер — по ним считается дисциплина.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={save} disabled={saving || forbidden}>
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Строка обязанности ───────────────────────────────────────────────────────

function RuleRow({
  template,
  members,
  me,
  canManage,
}: {
  template: DutyTemplateItem;
  members: DutyMember[];
  me: Me;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable =
    canManage && canEditDutyTemplate(template, me);
  const mine = isOwnDuty(template, me);

  async function toggleActive() {
    setBusy(true);
    try {
      const res = await fetch("/api/duties/templates", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: template.id, active: !template.active }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error === "own_duty_forbidden"
            ? "Свой регламент правит только директор"
            : "Ошибка",
        );
      }
      toast.success(template.active ? "Обязанность выключена" : "Обязанность включена");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 px-3 py-2",
        !template.active && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {template.frequency === "daily" ? (
          <Repeat className="size-3.5 shrink-0 text-sky-300" />
        ) : (
          <CalendarDays className="size-3.5 shrink-0 text-violet-300" />
        )}
        <span className="font-medium">{template.title}</span>
        {mine && (
          <Badge variant="secondary" className="text-[10px]">
            моя
          </Badge>
        )}
        {!template.active && (
          <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">
            выключена
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1">
          {canManage && !editable && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Lock className="size-3" />
              {OWN_DUTY_HINT}
            </span>
          )}
          {editable && (
            <>
              <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
                <Pencil className="size-3.5" />
                Изменить
              </Button>
              <Button size="xs" variant="ghost" onClick={toggleActive} disabled={busy}>
                {template.active ? "Выключить" : "Включить"}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-0.5 text-xs text-muted-foreground">
        {template.scheduleLabel} · {template.hoursToComplete} ч на выполнение ·{" "}
        {template.requiresReport ? "отчёт обязателен" : "без отчёта"}
      </div>

      {template.description && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-3.5 transition", expanded && "rotate-180")} />
            Как выполнять
          </button>
          {expanded && (
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {template.description}
            </p>
          )}
        </div>
      )}

      {template.updatedAt && (
        <div className="mt-1 text-[10px] text-muted-foreground/70">
          изменено {new Date(template.updatedAt).toLocaleDateString("ru-RU")}
          {template.updatedByName && ` · ${template.updatedByName}`}
        </div>
      )}

      {editable && open && (
        <RuleDialog
          template={template}
          members={members}
          me={me}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </div>
  );
}

// ─── Экран «Регламент»: сотрудники карточками → регламент конкретного человека ─

type RuleGroup = {
  key: string; // «user:<id>» / «role:<role>» — он же цель для новой обязанности
  title: string;
  subtitle: string;
  items: DutyTemplateItem[];
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// Карточка сотрудника: сколько на нём обязанностей, когда первый дедлайн и
// что именно — чтобы выбирать человека, не открывая всех подряд.
function PersonCard({
  group,
  mine,
  onOpen,
}: {
  group: RuleGroup;
  mine: boolean;
  onOpen: () => void;
}) {
  const active = group.items.filter((t) => t.active);
  const daily = active.filter((t) => t.frequency === "daily").length;
  const weekly = active.length - daily;
  const off = group.items.length - active.length;
  const firstDue = active.map((t) => t.dueTime).sort()[0] ?? null;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
      className="cursor-pointer py-0 transition hover:border-border hover:shadow-lg"
    >
      <CardContent className="space-y-2 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
            {initials(group.title)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{group.title}</span>
              {mine && (
                <Badge variant="secondary" className="text-[10px]">
                  я
                </Badge>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">{group.subtitle}</div>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {active.length} {plural(active.length, "обязанность", "обязанности", "обязанностей")}
          </span>
          <span>·</span>
          <span>{daily} ежедн.</span>
          {weekly > 0 && (
            <>
              <span>·</span>
              <span>{weekly} недел.</span>
            </>
          )}
          {firstDue && (
            <>
              <span>·</span>
              <span>первый дедлайн {firstDue}</span>
            </>
          )}
          {off > 0 && (
            <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">
              {off} выключено
            </Badge>
          )}
        </div>

        <div className="space-y-0.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
          {active.slice(0, 3).map((t) => (
            <div key={t.id} className="truncate">
              {t.dueTime} · {t.title}
            </div>
          ))}
          {active.length > 3 && <div>ещё {active.length - 3}…</div>}
          {active.length === 0 && <div>действующих обязанностей нет</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function DutyRules({
  templates,
  members,
  me,
  canManage,
}: {
  templates: DutyTemplateItem[];
  members: DutyMember[];
  me: Me;
  canManage: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  // Группируем по исполнителю: регламент читают как «что должен человек»,
  // а не как плоский список из 25 строк.
  const groups = useMemo(() => {
    const map = new Map<string, RuleGroup>();
    for (const t of templates) {
      const key = t.assigneeUserId ? `user:${t.assigneeUserId}` : `role:${t.role}`;
      const g =
        map.get(key) ??
        {
          key,
          title: t.assigneeName ?? `Все с ролью «${t.roleLabel}»`,
          subtitle: t.assigneeName ? t.roleLabel : "по роли, поимённо не закреплено",
          items: [],
        };
      g.items.push(t);
      map.set(key, g);
    }
    for (const g of map.values()) {
      // Активные сверху, внутри — по времени дедлайна: так читается как распорядок дня
      g.items.sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          a.dueTime.localeCompare(b.dueTime) ||
          a.title.localeCompare(b.title),
      );
    }
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "ru"));
  }, [templates]);

  const opened = openKey ? groups.find((g) => g.key === openKey) ?? null : null;
  const activeCount = templates.filter((t) => t.active).length;
  const isMineGroup = (g: RuleGroup) =>
    g.items.some((t) => isOwnDuty(t, me));

  // ── Регламент одного сотрудника ──────────────────────────────────────────
  if (opened) {
    return (
      <div className="space-y-3">
        <Card className="py-0">
          <CardContent className="space-y-3 px-4 py-4">
            <Button size="xs" variant="ghost" onClick={() => setOpenKey(null)}>
              <ChevronLeft className="size-3.5" />
              Все сотрудники
            </Button>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                {initials(opened.title)}
              </div>
              <div className="min-w-0">
                <div className="font-medium">{opened.title}</div>
                <div className="text-xs text-muted-foreground">
                  {opened.subtitle} ·{" "}
                  {opened.items.filter((t) => t.active && t.frequency === "daily").length}{" "}
                  ежедневных ·{" "}
                  {opened.items.filter((t) => t.active && t.frequency === "weekly").length}{" "}
                  недельных
                </div>
              </div>
              {canManage && (
                <Button size="sm" className="ml-auto" onClick={() => setAddOpen(true)}>
                  <Plus className="size-4" />
                  Добавить обязанность
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="py-0">
          <CardContent className="space-y-1.5 px-4 py-4">
            {opened.items.map((t) => (
              <RuleRow
                key={t.id}
                template={t}
                members={members}
                me={me}
                canManage={canManage}
              />
            ))}
          </CardContent>
        </Card>

        {canManage && addOpen && (
          <RuleDialog
            members={members}
            me={me}
            defaultTarget={opened.key}
            open={addOpen}
            onOpenChange={setAddOpen}
          />
        )}
      </div>
    );
  }

  // ── Все сотрудники карточками ────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <Card className="py-0">
        <CardContent className="flex flex-wrap items-start justify-between gap-2 px-4 py-4">
          <div>
            <div className="text-sm font-medium">
              Регламент компании · {activeCount} действующих обязанностей у{" "}
              {groups.length} исполнителей
            </div>
            <div className="text-xs text-muted-foreground">
              Откройте сотрудника — увидите весь его регламент: что делает, к какому часу
              и с каким отчётом.
              {canManage &&
                (me.role === "owner" || me.role === "admin"
                  ? " Вы правите регламент кому угодно, включая себя."
                  : " Вы правите регламент команде; свой меняет директор.")}
            </div>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              Добавить обязанность
            </Button>
          )}
        </CardContent>
      </Card>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Регламент пока пуст.
            {canManage && " Добавьте первую обязанность — она начнёт приходить задачей."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <PersonCard
              key={g.key}
              group={g}
              mine={isMineGroup(g)}
              onOpen={() => setOpenKey(g.key)}
            />
          ))}
        </div>
      )}

      {canManage && addOpen && (
        <RuleDialog members={members} me={me} open={addOpen} onOpenChange={setAddOpen} />
      )}
    </div>
  );
}
