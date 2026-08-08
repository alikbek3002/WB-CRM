"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Layers, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Input } from "@/frontend/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/frontend/components/ui/select";
import { formatNumber } from "@/shared/format";
import type { ProductGroup, ProductListItem } from "@/shared/types";

// Сентинел «без группы» для Select: value не бывает null
const NONE = "none";

// ─── Селект назначения группы товару ─────────────────────────────────────────
// Самодостаточный: сам шлёт PATCH и обновляет страницу. Используется в карточке
// товара и в колонке «Группа» списка — «раскидать» можно из обоих мест.
export function GroupSelect({
  productId,
  value,
  groups,
  className,
}: {
  productId: string;
  value: string | null;
  groups: ProductGroup[];
  className?: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function assign(next: string) {
    const groupId = next === NONE ? null : next;
    if (groupId === value) return;
    setSaving(true);
    try {
      const res = await fetch("/api/products", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: productId, groupId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      const name = groups.find((g) => g.id === groupId)?.name;
      toast.success(name ? `Товар в группе «${name}»` : "Товар убран из группы");
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось назначить группу: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => v && assign(String(v))}
      disabled={saving}
    >
      <SelectTrigger className={className ?? "w-full"} aria-label="Группа товара">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Без группы</SelectItem>
        {groups.map((g) => (
          <SelectItem key={g.id} value={g.id}>
            {g.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Кнопка «Группы» + диалог управления ─────────────────────────────────────
// Создать / переименовать / удалить. Удаление группу распускает, товары
// остаются без группы (FK on delete set null) — ничего не пропадает.
export function GroupsManageDialog({
  groups,
  products,
}: {
  groups: ProductGroup[];
  products: ProductListItem[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) {
      if (p.groupId) map.set(p.groupId, (map.get(p.groupId) ?? 0) + 1);
    }
    return map;
  }, [products]);

  async function call(
    method: "POST" | "PATCH" | "DELETE",
    payload: { id?: string; name?: string },
    okMessage: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const url =
        method === "DELETE"
          ? `/api/product-groups?id=${payload.id}`
          : "/api/product-groups";
      const res = await fetch(url, {
        method,
        ...(method !== "DELETE" && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.error === "duplicate_name") {
          throw new Error("Группа с таким названием уже есть");
        }
        throw new Error(data?.error ?? "Ошибка");
      }
      toast.success(okMessage);
      router.refresh();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    if (await call("POST", { name }, `Группа «${name}» создана`)) setNewName("");
  }

  async function rename(id: string) {
    const name = editName.trim();
    if (!name) return;
    if (await call("PATCH", { id, name }, `Группа переименована в «${name}»`)) {
      setEditingId(null);
    }
  }

  async function remove(g: ProductGroup) {
    if (
      await call(
        "DELETE",
        { id: g.id },
        `Группа «${g.name}» удалена, товары остались без группы`,
      )
    ) {
      setConfirmId(null);
    }
  }

  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <Layers className="size-3.5" />
        Группы
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Группы товаров</DialogTitle>
            <DialogDescription>
              Поделите каталог между ответственными: создайте группы и назначайте
              их товарам — в карточке или в списке. Фильтр по группе — над
              каталогом.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="Название группы, например «Группа Алик»"
              disabled={busy}
            />
            <Button onClick={create} disabled={busy || !newName.trim()}>
              <Plus className="size-4" />
              Создать
            </Button>
          </div>

          {groups.length === 0 ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              Групп пока нет — создайте первую.
            </p>
          ) : (
            <div className="space-y-1">
              {groups.map((g) => (
                <div
                  key={g.id}
                  className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                >
                  {editingId === g.id ? (
                    <>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && rename(g.id)}
                        className="h-7"
                        autoFocus
                        disabled={busy}
                      />
                      <Button
                        size="xs"
                        onClick={() => rename(g.id)}
                        disabled={busy || !editName.trim()}
                        aria-label="Сохранить название"
                      >
                        <Check className="size-3.5" />
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                        aria-label="Отменить переименование"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {g.name}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatNumber(counts.get(g.id) ?? 0)} тов.
                      </span>
                      {confirmId === g.id ? (
                        <>
                          <Button
                            size="xs"
                            variant="destructive"
                            onClick={() => remove(g)}
                            disabled={busy}
                          >
                            Точно удалить?
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setConfirmId(null)}
                            disabled={busy}
                            aria-label="Отменить удаление"
                          >
                            <X className="size-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setEditingId(g.id);
                              setEditName(g.name);
                              setConfirmId(null);
                            }}
                            disabled={busy}
                            aria-label={`Переименовать группу ${g.name}`}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setConfirmId(g.id);
                              setEditingId(null);
                            }}
                            disabled={busy}
                            aria-label={`Удалить группу ${g.name}`}
                          >
                            <Trash2 className="size-3.5 text-red-400" />
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
