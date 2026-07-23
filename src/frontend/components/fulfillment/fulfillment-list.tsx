"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import { formatNumber } from "@/shared/format";
import type { Supply, SupplyStatus } from "@/shared/types";

// Следующая стадия фул-фирмы: принят → в разбор → на склад
const NEXT_STAGE: Partial<Record<SupplyStatus, { status: SupplyStatus; label: string }>> = {
  received: { status: "sorting", label: "В разбор" },
  sorting: { status: "in_stock", label: "На склад (лежит)" },
};

function stageBadgeClass(status: SupplyStatus): string {
  switch (status) {
    case "received":
      return "border-sky-500/50 text-sky-300";
    case "sorting":
      return "border-amber-500/50 text-amber-400";
    case "in_stock":
      return "border-emerald-500/50 text-emerald-400";
    case "distributed":
      return "border-emerald-500/50 text-emerald-400";
    default:
      return "border-border text-muted-foreground";
  }
}

export function FulfillmentList({
  cards,
  canReceive,
}: {
  cards: Supply[];
  canReceive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function advance(s: Supply) {
    const next = NEXT_STAGE[s.status];
    if (!next) return;
    setBusy(s.id);
    try {
      const res = await fetch(`/api/supplies/${s.id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next.status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      toast.success(data.persisted ? `Статус: ${next.label}` : `Статус принят (демо): ${next.label}`);
      router.refresh();
    } catch (e) {
      toast.error(`Не удалось сменить статус: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (cards.length === 0) {
    return (
      <Card className="py-8">
        <CardContent className="px-4 text-center text-sm text-muted-foreground">
          Принятых поставок пока нет.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {cards.map((s) => {
        const next = NEXT_STAGE[s.status];
        return (
          <Card key={s.id} className="py-3">
            <CardContent className="px-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{s.title}</div>
                  <div className="text-xs text-muted-foreground">{s.factoryName}</div>
                </div>
                <Badge variant="outline" className={`text-[10px] ${stageBadgeClass(s.status)}`}>
                  {s.statusLabel}
                </Badge>
              </div>
              <div className="mt-2 flex items-center gap-4 text-sm">
                <span className="text-muted-foreground">
                  Принято{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {formatNumber(s.receivedQty ?? s.quantity)}
                  </span>{" "}
                  из {formatNumber(s.quantity)} шт
                </span>
                {s.shortage > 0 && (
                  <Badge variant="outline" className="border-red-500/50 text-[10px] text-red-400">
                    недостача −{s.shortage}
                  </Badge>
                )}
              </div>
              {(canReceive && next) || s.status === "in_stock" ? (
                <div className="mt-3">
                  {canReceive && next ? (
                    <Button size="sm" variant="outline" onClick={() => advance(s)} disabled={busy === s.id}>
                      {busy === s.id ? "…" : next.label}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Готово к распределению — страница «Поставки»
                    </span>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
