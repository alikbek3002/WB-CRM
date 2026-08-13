"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Coins } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import { Input } from "@/frontend/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import { formatAmount, formatRate } from "@/shared/format";
import type { CurrencyRate, CurrencyRatesView } from "@/shared/types";

function updatedLabel(rate: CurrencyRate): string {
  if (rate.isDefault || !rate.updatedAt) return "курс не сводили";
  const when = new Date(rate.updatedAt).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return rate.updatedByName ? `${when} · ${rate.updatedByName}` : when;
}

// Одна строка = одна валюта. Правка ручная и штучная: курс — множитель под
// всеми суммами компании, поэтому сохраняем по кнопке, а не по каждому нажатию
// клавиши.
function RateRow({
  rate,
  canEdit,
  onSaved,
}: {
  rate: CurrencyRate;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(formatRate(rate.rateToBase).replace(",", "."));
  const [saving, setSaving] = useState(false);

  const parsed = Number(value.replace(",", "."));
  const valid = Number.isFinite(parsed) && parsed > 0;
  const dirty = valid && Math.abs(parsed - rate.rateToBase) > 1e-9;

  async function save() {
    if (!valid) {
      toast.error("Курс — положительное число");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/finance/currency-rates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: rate.code, rate: parsed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Ошибка");
      toast.success(
        data?.persisted === false
          ? "Демо-режим: курс принят, но сохранять его некуда"
          : (data?.message ?? "Курс обновлён"),
      );
      onSaved();
    } catch (e) {
      toast.error(`Не удалось сохранить курс: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-xs font-semibold">
            {rate.sign}
          </span>
          <div className="min-w-0">
            <div className="truncate">{rate.name}</div>
            <div className="text-[11px] uppercase text-muted-foreground">{rate.code}</div>
          </div>
        </div>
      </TableCell>

      <TableCell>
        {rate.isBase ? (
          <span className="text-sm text-muted-foreground">
            Базовая валюта — все суммы приводятся к ней
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-sm text-muted-foreground">
              1 {rate.sign} =
            </span>
            <Input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty) void save();
              }}
              disabled={!canEdit || saving}
              className="h-8 w-28 tabular-nums"
              aria-label={`Курс ${rate.name} к сому`}
            />
            <span className="text-sm text-muted-foreground">сом</span>
            {canEdit && (
              <Button size="xs" variant={dirty ? "default" : "outline"} onClick={save} disabled={saving || !dirty}>
                {saving ? "…" : dirty ? "Сохранить" : <Check className="size-3.5" />}
              </Button>
            )}
          </div>
        )}
      </TableCell>

      <TableCell className="hidden text-sm text-muted-foreground tabular-nums sm:table-cell">
        {rate.isBase ? "—" : `100 ${rate.sign} = ${formatAmount(rate.rateToBase * 100)}`}
      </TableCell>

      <TableCell className="text-right">
        {rate.isBase ? (
          <Badge variant="secondary" className="text-[10px]">
            всегда 1
          </Badge>
        ) : rate.isDefault ? (
          <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-400">
            по умолчанию
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground">{updatedLabel(rate)}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export function CurrencyRatesBoard({
  view,
  canEdit,
}: {
  view: CurrencyRatesView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const pending = view.rates.filter((r) => !r.isBase && r.isDefault);

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="flex flex-wrap items-start justify-between gap-3 px-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex size-9 items-center justify-center rounded-lg bg-muted">
              <Coins className="size-4" />
            </span>
            <div className="text-sm">
              <div className="font-medium">Базовая валюта компании — сом</div>
              <p className="mt-0.5 max-w-2xl text-muted-foreground">
                Кабинет WB считает в сомах, поэтому выручка и удержания маркетплейса
                берутся как есть. Всё остальное — расходы, оплаты фабрикам, карго,
                зарплаты, заявки на выплату — переводится в сомы по курсам ниже.
                {canEdit
                  ? " Правьте курс, когда он реально изменился: суммы пересчитаются сразу на всех вкладках."
                  : " Курсы сводят директор и старший менеджер."}
              </p>
            </div>
          </div>
          {view.updatedAt && (
            <div className="text-right text-[11px] text-muted-foreground">
              Последняя правка
              <br />
              {new Date(view.updatedAt).toLocaleString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Валюта</TableHead>
                <TableHead>Курс к сому</TableHead>
                <TableHead className="hidden sm:table-cell">Пример</TableHead>
                <TableHead className="text-right">Обновлено</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rates.map((rate) => (
                <RateRow
                  key={rate.code}
                  rate={rate}
                  canEdit={canEdit && !rate.isBase}
                  onSaved={() => router.refresh()}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {pending.map((r) => r.name.toLowerCase()).join(", ")} — стоят наши ориентиры, а
          не ваш курс. Пока их не свели, суммы в этих валютах в отчётах приблизительные.
        </p>
      )}
    </div>
  );
}
