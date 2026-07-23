"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import type { ProductListItem, ProductRecommendation } from "@/shared/types";

const SEVERITY_CLASS: Record<string, string> = {
  high: "border-red-500/50 text-red-400",
  medium: "border-amber-500/50 text-amber-400",
  low: "border-sky-500/50 text-sky-300",
};

export function RecoButton({ product }: { product: ProductListItem }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reco, setReco] = useState<ProductRecommendation | null>(null);

  async function load() {
    setOpen(true);
    if (reco) return; // уже загружено
    setLoading(true);
    try {
      const res = await fetch("/api/products/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          nmId: product.nmId,
          title: product.title,
          status: product.status,
          salesRank30d: product.salesRank30d,
          avgDailySales: product.avgDailySales,
          daysOfCover: product.daysOfCover,
          stockQty: product.stockQty,
          inTransitToMoscow: product.inTransitToMoscow,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      setReco(data.recommendation as ProductRecommendation);
    } catch (e) {
      toast.error(`Не удалось получить рекомендацию: ${(e as Error).message}`);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button size="xs" variant="outline" onClick={load}>
        <Sparkles className="size-3.5" />
        ИИ
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Рекомендация ИИ · {product.title}</DialogTitle>
            <DialogDescription>
              {reco?.source === "claude"
                ? "Разбор от Claude"
                : "Эвристический разбор (подключите ANTHROPIC_API_KEY для Claude)"}
            </DialogDescription>
          </DialogHeader>

          {loading && <p className="text-sm text-muted-foreground">Анализирую…</p>}

          {!loading && reco && (
            <div className="space-y-3">
              <p className="text-sm">{reco.summary}</p>

              {reco.problems.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">Проблемы</div>
                  {reco.problems.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <Badge
                        variant="outline"
                        className={`mt-0.5 text-[10px] ${SEVERITY_CLASS[p.severity] ?? ""}`}
                      >
                        {p.metric}
                      </Badge>
                      <span className="text-muted-foreground">{p.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Что сделать</div>
                {reco.recommendations.map((r, i) => (
                  <div key={i} className="rounded-lg border border-border/60 px-3 py-2 text-sm">
                    <div className="font-medium">
                      {i + 1}. {r.action}
                    </div>
                    <div className="text-xs text-muted-foreground">{r.impact}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
