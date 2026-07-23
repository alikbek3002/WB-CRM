"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
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

export type TeamOption = { id: string; name: string; roleLabel: string };

const PRIORITIES: Record<string, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  urgent: "Срочный",
};

// Создание задачи сотруднику (директор/ст. менеджер). Исполнителю — пуш в TG.
export function TaskForm({ team }: { team: TeamOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("none");
  const [priority, setPriority] = useState("normal");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);

  const assigneeItems = {
    none: "Без исполнителя",
    ...Object.fromEntries(team.map((t) => [t.id, `${t.name} · ${t.roleLabel}`])),
  };

  async function submit() {
    if (!title.trim()) {
      toast.error("Опишите задачу");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          priority,
          dueDate: dueDate || null,
          assigneeId: assigneeId === "none" ? null : assigneeId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(
        assigneeId === "none"
          ? "Задача создана"
          : "Задача создана — исполнителю отправлено уведомление в Telegram",
      );
      setTitle("");
      setAssigneeId("none");
      setPriority("normal");
      setDueDate("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось создать: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Новая задача
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новая задача</DialogTitle>
            <DialogDescription>
              Исполнитель получит уведомление в Telegram (если привязал бот).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="task-title">Что нужно сделать</Label>
              <Input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Например: проверить отзывы по джоггерам"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Исполнитель</Label>
              <Select
                value={assigneeId}
                items={assigneeItems}
                onValueChange={(v) => v && setAssigneeId(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Без исполнителя</SelectItem>
                  {team.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · {t.roleLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Приоритет</Label>
                <Select value={priority} items={PRIORITIES} onValueChange={(v) => v && setPriority(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PRIORITIES).map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="task-due">Срок</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Создание…" : "Создать"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
