"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlarmClock, CheckCircle2, ChevronDown, XCircle } from "lucide-react";
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
import { Label } from "@/frontend/components/ui/label";
import { cn } from "@/shared/utils";
import type { DutyItem } from "@/shared/types";

// Сколько осталось до дедлайна (на момент рендера)
function remainingLabel(dueAt: string): { text: string; danger: boolean } {
  const diffMin = Math.round((new Date(dueAt).getTime() - Date.now()) / 60_000);
  if (diffMin <= 0) return { text: "срок вышел", danger: true };
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return {
    text: `осталось ${h > 0 ? `${h} ч ` : ""}${m} мин`,
    danger: diffMin <= 45,
  };
}

const STATUS_META: Record<
  DutyItem["status"],
  { label: string; className: string }
> = {
  pending: { label: "В работе", className: "border-sky-500/50 text-sky-300" },
  done: { label: "Выполнено", className: "border-emerald-500/50 text-emerald-400" },
  missed: { label: "Просрочено", className: "border-red-500/50 text-red-400" },
};

function CompleteDialog({
  duty,
  open,
  onOpenChange,
}: {
  duty: DutyItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [report, setReport] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (duty.requiresReport && !report.trim()) {
      toast.error("Отчёт обязателен — опишите, что сделано");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/duties/${duty.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report: report.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(
        data.onTime
          ? `«${duty.title}» — выполнено вовремя, отчёт отправлен`
          : `«${duty.title}» — выполнено (после дедлайна), отчёт отправлен`,
      );
      setReport("");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось отправить: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Отчёт · {duty.title}</DialogTitle>
          <DialogDescription>
            Что сделано, цифры, проблемы. Отчёт увидят директор и старший менеджер.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="duty-report">Отчёт о выполнении</Label>
          <textarea
            id="duty-report"
            value={report}
            onChange={(e) => setReport(e.target.value)}
            rows={5}
            placeholder="Например: закрыла 14 ночных отзывов до 10:40, негатива 2 (пересорт по артикулу 167518686 — передала в логистику)…"
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Отправка…" : "Выполнено — отправить отчёт"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DutyCard({
  duty,
  canComplete,
}: {
  duty: DutyItem;
  canComplete: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[duty.status];
  const remaining = duty.status === "pending" ? remainingLabel(duty.dueAt) : null;

  return (
    <Card
      className={cn(
        duty.status === "missed" && "border-red-500/40",
        duty.status === "done" && "opacity-80",
      )}
    >
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {duty.status === "done" ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
          ) : duty.status === "missed" ? (
            <XCircle className="size-4 shrink-0 text-red-400" />
          ) : (
            <AlarmClock className="size-4 shrink-0 text-sky-300" />
          )}
          <span className="font-medium">{duty.title}</span>
          <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
            {meta.label}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {duty.frequency === "daily" ? "ежедневно" : "еженедельно"}
          </Badge>
          <span className="ml-auto text-sm text-muted-foreground">
            {duty.dueLabel} · {duty.hoursToComplete} ч на выполнение
          </span>
        </div>

        {remaining && (
          <div className={cn("text-sm", remaining.danger ? "text-red-400" : "text-muted-foreground")}>
            ⏱ {remaining.text}
          </div>
        )}

        {duty.description && (
          <div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn("size-3.5 transition", expanded && "rotate-180")} />
              Регламент
            </button>
            {expanded && (
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {duty.description}
              </p>
            )}
          </div>
        )}

        {duty.status === "done" && duty.reportContent && (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="text-xs font-medium text-muted-foreground">
              Отчёт {duty.reportOnTime === false && "· после дедлайна"}
            </div>
            <p className="whitespace-pre-line text-sm">{duty.reportContent}</p>
          </div>
        )}

        {duty.status !== "done" && canComplete && (
          <div className="pt-1">
            <Button size="sm" onClick={() => setOpen(true)}>
              Выполнено — отчёт
            </Button>
            <CompleteDialog duty={duty} open={open} onOpenChange={setOpen} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DutiesList({
  duties,
  canComplete,
}: {
  duties: DutyItem[];
  canComplete: boolean;
}) {
  if (duties.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          На сегодня регламентных задач нет.
        </CardContent>
      </Card>
    );
  }

  const order: DutyItem["status"][] = ["pending", "missed", "done"];
  const sorted = [...duties].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  );

  return (
    <div className="space-y-2">
      {sorted.map((d) => (
        <DutyCard key={d.id} duty={d} canComplete={canComplete} />
      ))}
    </div>
  );
}
