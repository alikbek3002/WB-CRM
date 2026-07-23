"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";

// Ручной запуск синхронизации кабинета WB (карточки/цены/остатки/заказы/продажи).
// Крупный кабинет тянется партиями — может занять пару минут.
export function WbSyncButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    toast.info("Синхронизация WB запущена — может занять пару минут…");
    try {
      const res = await fetch("/api/sync/wb", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: 30, maxBatches: 2 }),
      });
      const data = await res.json();
      if (!res.ok && !data?.counts) {
        throw new Error(data?.errors?.[0] ?? data?.error ?? "Ошибка");
      }
      const c = data.counts ?? {};
      const parts = [
        c.cards != null && `карточек ${c.cards}`,
        c.stocks != null && `остатков ${c.stocks}`,
        c.orders != null && `заказов ${c.orders}`,
        c.sales != null && `продаж ${c.sales}`,
      ]
        .filter(Boolean)
        .join(", ");
      if (data.ok) {
        toast.success(`Синхронизировано (${data.seller}): ${parts}`);
      } else {
        toast.warning(
          `Частично (${parts}). ${data.errors?.[0] ?? ""} — запустите ещё раз, продолжит с места.`,
        );
      }
      router.refresh();
    } catch (e) {
      toast.error(`Синхронизация не удалась: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Button size="sm" onClick={run} disabled={running}>
      <RefreshCw className={`size-4 ${running ? "animate-spin" : ""}`} />
      {running ? "Синхронизация…" : "Синхронизировать"}
    </Button>
  );
}
