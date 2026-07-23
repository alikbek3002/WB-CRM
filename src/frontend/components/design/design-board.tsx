"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, ImageOff, Palette, Plus } from "lucide-react";
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
import type { DesignRequest, DesignStatus } from "@/shared/types";

export type ProductOption = { id: string; title: string };

const STATUS_META: Record<DesignStatus, { label: string; className: string }> = {
  new: { label: "Новая", className: "border-sky-500/50 text-sky-300" },
  in_progress: { label: "В работе", className: "border-amber-500/50 text-amber-400" },
  review: { label: "На проверке", className: "border-violet-500/50 text-violet-300" },
  done: { label: "Готово", className: "border-emerald-500/50 text-emerald-400" },
  rejected: { label: "Отменена", className: "border-red-500/50 text-red-400" },
};

const FILTERS: { key: DesignStatus | "all"; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "new", label: "Новые" },
  { key: "in_progress", label: "В работе" },
  { key: "review", label: "На проверке" },
  { key: "done", label: "Готово" },
  { key: "rejected", label: "Отменённые" },
];

// ─── Создание заявки ─────────────────────────────────────────────────────────

function CreateRequestDialog({
  products,
  open,
  onOpenChange,
}: {
  products: ProductOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [productId, setProductId] = useState<string>("none");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [references, setReferences] = useState("");
  const [saving, setSaving] = useState(false);

  function pickProduct(id: string) {
    setProductId(id);
    if (id !== "none" && !title.trim()) {
      const p = products.find((x) => x.id === id);
      if (p) setTitle(`Дизайн карточки: ${p.title}`);
    }
  }

  async function submit() {
    if (!title.trim()) {
      toast.error("Укажите, что нужно сделать");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: productId === "none" ? null : productId,
          title: title.trim(),
          brief: brief.trim() || null,
          referencesText: references.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success("Заявка на дизайн создана — дизайнер увидит её в очереди");
      setTitle("");
      setBrief("");
      setReferences("");
      setProductId("none");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось создать заявку: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Новая заявка на дизайн</DialogTitle>
          <DialogDescription>
            Опишите задачу и приложите референсы — дизайнер возьмёт в работу.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Товар (необязательно)</Label>
            <Select value={productId} onValueChange={(v) => v && pickProduct(v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Без привязки к товару</SelectItem>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dr-title">Что нужно</Label>
            <Input
              id="dr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например: новая обложка + 3 слайда воронки"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dr-brief">Бриф</Label>
            <textarea
              id="dr-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              placeholder="Задача, акценты, боли покупателя, УТП. Товар 70–80% кадра, безопасные зоны под плашки WB…"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dr-refs">Референсы (ссылки, примеры)</Label>
            <textarea
              id="dr-refs"
              value={references}
              onChange={(e) => setReferences(e.target.value)}
              rows={3}
              placeholder={"Ссылки на конкурентов, примеры стиля, фото:\nhttps://…\nhttps://…"}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Создание…" : "Создать заявку"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Сдача макета ────────────────────────────────────────────────────────────

function SubmitResultDialog({
  request,
  open,
  onOpenChange,
}: {
  request: DesignRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(request.resultUrl ?? "");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!url.trim() || !/^https?:\/\//.test(url.trim())) {
      toast.error("Нужна ссылка на макет (Figma, диск…) — начинается с http");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/design/${request.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          resultUrl: url.trim(),
          comment: comment.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success("Макет отправлен на проверку");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось сдать макет: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Сдать макет · {request.title}</DialogTitle>
          <DialogDescription>
            Ссылка на готовый дизайн — её увидят директор и старший менеджер.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="res-url">Ссылка на макет</Label>
            <Input
              id="res-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://figma.com/… или https://drive.google.com/…"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="res-comment">Комментарий (необязательно)</Label>
            <Input
              id="res-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Что сделано, варианты, вопросы"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Отправка…" : "Отправить на проверку"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Карточка заявки ─────────────────────────────────────────────────────────

function RequestCard({
  request,
  canSubmit,
  canApprove,
}: {
  request: DesignRequest;
  canSubmit: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = STATUS_META[request.status];

  async function act(action: "take" | "approve" | "return" | "cancel") {
    let comment: string | undefined;
    if (action === "return") {
      const v = window.prompt("Что доработать? (комментарий дизайнеру)");
      if (!v?.trim()) return;
      comment = v.trim();
    }
    if (action === "cancel") {
      const v = window.prompt("Причина отмены (необязательно)") ?? undefined;
      comment = v?.trim() || undefined;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/design/${request.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, comment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(
        action === "take"
          ? "Заявка в работе"
          : action === "approve"
            ? "Дизайн утверждён"
            : action === "return"
              ? "Возвращено на доработку"
              : "Заявка отменена",
      );
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Референсы: ссылки — кликабельными
  const refLines = (request.referencesText ?? "").split("\n").filter(Boolean);

  return (
    <Card className={cn(request.status === "rejected" && "opacity-60")}>
      <CardContent className="flex gap-3 py-4">
        {request.productPhotoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={request.productPhotoUrl}
            alt=""
            loading="lazy"
            className="h-24 w-[72px] shrink-0 rounded-md border border-border/60 object-cover"
          />
        ) : (
          <div className="flex h-24 w-[72px] shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
            <ImageOff className="size-5" />
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{request.title}</span>
            <Badge variant="outline" className={`text-[10px] ${meta.className}`}>
              {meta.label}
            </Badge>
            <span className="ml-auto text-xs text-muted-foreground">
              {new Date(request.createdAt).toLocaleDateString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
              })}
            </span>
          </div>

          {request.productTitle && (
            <div className="truncate text-xs text-muted-foreground">
              Товар: {request.productTitle}
            </div>
          )}
          {request.brief && (
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {request.brief}
            </p>
          )}
          {refLines.length > 0 && (
            <div className="space-y-0.5 text-xs">
              <span className="font-medium text-muted-foreground">Референсы:</span>
              {refLines.map((line, i) =>
                /^https?:\/\//.test(line.trim()) ? (
                  <a
                    key={i}
                    href={line.trim()}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-sky-300 hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    {line.trim().slice(0, 60)}
                  </a>
                ) : (
                  <div key={i} className="text-muted-foreground">
                    {line}
                  </div>
                ),
              )}
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            Заказчик: {request.requesterName}
            {request.assigneeName && ` → дизайнер: ${request.assigneeName}`}
          </div>

          {request.resultUrl && (
            <a
              href={request.resultUrl}
              target="_blank"
              rel="noreferrer"
              className="flex w-fit items-center gap-1.5 rounded-md border border-violet-500/40 px-2.5 py-1 text-sm text-violet-300 hover:bg-violet-500/10"
            >
              <Palette className="size-3.5" />
              Открыть макет
            </a>
          )}
          {request.resultComment && (
            <p className="text-xs text-muted-foreground">
              Дизайнер: {request.resultComment}
            </p>
          )}
          {request.reviewComment && (
            <p className="text-xs text-amber-400/90">
              Руководитель: {request.reviewComment}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5 pt-1">
            {canSubmit && request.status === "new" && (
              <Button size="xs" onClick={() => act("take")} disabled={busy}>
                Взять в работу
              </Button>
            )}
            {canSubmit && (request.status === "in_progress" || request.status === "new") && (
              <Button size="xs" variant="secondary" onClick={() => setSubmitOpen(true)} disabled={busy}>
                Сдать макет
              </Button>
            )}
            {canApprove && request.status === "review" && (
              <>
                <Button size="xs" onClick={() => act("approve")} disabled={busy}>
                  Утвердить
                </Button>
                <Button size="xs" variant="outline" onClick={() => act("return")} disabled={busy}>
                  На доработку
                </Button>
              </>
            )}
            {canApprove &&
              (request.status === "new" || request.status === "in_progress") && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => act("cancel")}
                  disabled={busy}
                  className="text-muted-foreground"
                >
                  Отменить
                </Button>
              )}
          </div>
        </div>
      </CardContent>
      <SubmitResultDialog request={request} open={submitOpen} onOpenChange={setSubmitOpen} />
    </Card>
  );
}

// ─── Доска ───────────────────────────────────────────────────────────────────

export function DesignBoard({
  requests,
  products,
  canRequest,
  canSubmit,
  canApprove,
}: {
  requests: DesignRequest[];
  products: ProductOption[];
  canRequest: boolean;
  canSubmit: boolean;
  canApprove: boolean;
}) {
  const [filter, setFilter] = useState<DesignStatus | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);

  const visible = useMemo(
    () => (filter === "all" ? requests : requests.filter((r) => r.status === filter)),
    [requests, filter],
  );

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of requests) c.set(r.status, (c.get(r.status) ?? 0) + 1);
    return c;
  }, [requests]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="xs"
            variant={filter === f.key ? "secondary" : "ghost"}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key !== "all" && (counts.get(f.key) ?? 0) > 0 && (
              <span className="ml-1 text-muted-foreground">{counts.get(f.key)}</span>
            )}
          </Button>
        ))}
        {canRequest && (
          <Button size="sm" className="ml-auto" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Новая заявка
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {requests.length === 0
              ? "Заявок на дизайн пока нет. Менеджер создаёт заявку — дизайнер берёт в работу и сдаёт макет."
              : "По этому фильтру заявок нет."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              canSubmit={canSubmit}
              canApprove={canApprove}
            />
          ))}
        </div>
      )}

      <CreateRequestDialog
        products={products}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
