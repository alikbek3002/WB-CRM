"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Clock, Play, X } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/frontend/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Label } from "@/frontend/components/ui/label";
import type { TaskItem } from "@/shared/types";
import { cn } from "@/shared/utils";

const COLUMNS: { status: TaskItem["status"]; title: string }[] = [
  { status: "open", title: "Открытые" },
  { status: "in_progress", title: "В работе" },
  { status: "done", title: "Выполнены" },
];

const PRIORITY_LABELS: Record<TaskItem["priority"], string> = {
  low: "низкий",
  normal: "обычный",
  high: "высокий",
  urgent: "срочно",
};

function priorityClass(p: TaskItem["priority"]) {
  switch (p) {
    case "urgent":
      return "border-red-500/50 text-red-400";
    case "high":
      return "border-amber-500/50 text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

// ── Диалог отчёта: закрыть задачу без текста нельзя ─────────────────────────
function CompleteDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [report, setReport] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!report.trim()) {
      toast.error("Отчёт обязателен — опишите, что именно сделано");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report: report.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Ошибка");
      toast.success(data.message ?? "Задача закрыта, отчёт отправлен");
      setReport("");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось закрыть: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Отчёт о выполнении</DialogTitle>
          <DialogDescription>
            «{task.title}» — напишите, что именно сделано. Отчёт увидят директор и
            старшие менеджеры.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="task-report">
            Что сделано <span className="text-red-400">*</span>
          </Label>
          <textarea
            id="task-report"
            autoFocus
            value={report}
            onChange={(e) => setReport(e.target.value)}
            rows={5}
            maxLength={2000}
            placeholder="Например: обновила фото и описание карточки, добавила 3 инфографики, отправила на модерацию — опубликуется завтра"
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <p className="text-xs text-muted-foreground">
            Конкретика: цифры, что изменилось, что осталось. {report.trim().length}/2000
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving || !report.trim()}>
            {saving ? "Отправляю…" : "Выполнено"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TaskBoard({
  tasks,
  userId,
  canLead,
}: {
  tasks: TaskItem[];
  userId: string;
  canLead: boolean; // owner/admin/manager — видит отчёты всех и может отменять
}) {
  const router = useRouter();
  const [completing, setCompleting] = useState<TaskItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mine = (t: TaskItem) => t.assigneeId === userId;
  const canAct = (t: TaskItem) => mine(t) || canLead;

  async function changeStatus(task: TaskItem, action: "start" | "cancel") {
    setBusy(task.id);
    try {
      const res = await fetch(`/api/tasks/${task.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Ошибка");
      toast.success(data.message);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <Card key={col.status} className="py-4">
              <CardHeader className="px-4">
                <CardTitle className="flex items-center justify-between text-sm">
                  {col.title}
                  <Badge variant="secondary">{items.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 px-4">
                {items.map((t) => (
                  <div
                    key={t.id}
                    className={cn(
                      "rounded-lg border border-border/70 bg-background/40 p-3",
                      mine(t) && t.status !== "done" && "border-primary/40",
                    )}
                  >
                    <div
                      className={cn(
                        "text-sm",
                        t.status === "done" && "text-muted-foreground line-through",
                      )}
                    >
                      {t.title}
                    </div>
                    {t.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="outline" className={cn("text-[10px]", priorityClass(t.priority))}>
                        {PRIORITY_LABELS[t.priority]}
                      </Badge>
                      {t.productLabel && (
                        <Badge variant="secondary" className="text-[10px]">
                          {t.productLabel}
                        </Badge>
                      )}
                      <span className="ml-auto">{mine(t) ? "вы" : t.assignee}</span>
                      {t.dueDate && (
                        <span>
                          ·{" "}
                          {new Date(t.dueDate).toLocaleDateString("ru-RU", {
                            day: "numeric",
                            month: "short",
                          })}
                        </span>
                      )}
                    </div>

                    {/* Отчёт о выполнении — виден исполнителю и руководству */}
                    {t.status === "done" && t.report && (canLead || mine(t)) && (
                      <div className="mt-2 rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                          <CheckCircle2 className="size-3" />
                          Отчёт
                          {t.completedOnTime === false && (
                            <span className="flex items-center gap-1 text-amber-400">
                              <Clock className="size-3" /> после срока
                            </span>
                          )}
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                          {t.report}
                        </p>
                      </div>
                    )}
                    {t.status === "done" && !t.report && (canLead || mine(t)) && (
                      <p className="mt-2 text-[11px] text-muted-foreground italic">
                        Закрыта до введения обязательных отчётов
                      </p>
                    )}

                    {/* Действия */}
                    {t.status !== "done" && canAct(t) && (
                      <div className="mt-2 flex gap-1.5">
                        {t.status === "open" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={busy === t.id}
                            onClick={() => changeStatus(t, "start")}
                          >
                            <Play className="size-3" /> В работу
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          disabled={busy === t.id}
                          onClick={() => setCompleting(t)}
                        >
                          <CheckCircle2 className="size-3" /> Выполнено
                        </Button>
                        {canLead && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-7 px-2 text-xs text-muted-foreground"
                            disabled={busy === t.id}
                            onClick={() => changeStatus(t, "cancel")}
                            title="Отменить задачу"
                          >
                            <X className="size-3" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {items.length === 0 && (
                  <div className="py-6 text-center text-xs text-muted-foreground">Нет задач</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {completing && (
        <CompleteDialog
          task={completing}
          open={Boolean(completing)}
          onOpenChange={(o) => !o && setCompleting(null)}
        />
      )}
    </>
  );
}
