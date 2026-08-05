"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Banknote,
  Boxes,
  FileText,
  Image as ImageIcon,
  Megaphone,
  Ruler,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Skeleton } from "@/frontend/components/ui/skeleton";
import { formatNumber } from "@/shared/format";
import type {
  ProductListItem,
  ProductRecoArea,
  ProductRecommendation,
} from "@/shared/types";

const SEVERITY_CLASS: Record<string, string> = {
  high: "border-red-500/50 text-red-400",
  medium: "border-amber-500/50 text-amber-400",
  low: "border-sky-500/50 text-sky-300",
};

// Область совета → иконка и подпись: видно с одного взгляда, что чинить
const AREA: Record<ProductRecoArea, { icon: typeof ImageIcon; label: string }> = {
  photo: { icon: ImageIcon, label: "Фото" },
  price: { icon: Banknote, label: "Цена" },
  description: { icon: FileText, label: "Описание" },
  sizes: { icon: Ruler, label: "Размеры" },
  ads: { icon: Megaphone, label: "Реклама" },
  supply: { icon: Boxes, label: "Поставка" },
  other: { icon: Wrench, label: "Прочее" },
};

const VERDICT: Record<
  ProductRecommendation["verdict"],
  { label: string; className: string }
> = {
  strong: { label: "Хороший товар", className: "border-emerald-500/50 text-emerald-400" },
  ok: { label: "Есть что улучшить", className: "border-amber-500/50 text-amber-400" },
  weak: { label: "Слабый товар", className: "border-red-500/50 text-red-400" },
};

/** Медианы каталога — чтобы ИИ сравнивал товар с остальными товарами продавца. */
export function catalogContext(all: ProductListItem[]) {
  if (all.length === 0) return undefined;
  const median = (nums: number[]) => {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    medianSales30d: median(all.map((p) => p.salesRank30d)) ?? 0,
    medianPrice: median(
      all.map((p) => p.priceDiscountedWb).filter((v): v is number => v !== null),
    ),
    products: all.length,
  };
}

// Шаг воронки в разборе: показ → корзина → заказ → выкуп
function FunnelStep({
  label,
  value,
  pct,
  hint,
}: {
  label: string;
  value: number;
  pct?: number;
  hint: string;
}) {
  return (
    <div className="flex-1" title={hint}>
      <div className="text-[10px] leading-tight text-muted-foreground">{label}</div>
      <div className="text-sm font-medium leading-tight tabular-nums">
        {formatNumber(value)}
      </div>
      {pct !== undefined && (
        <div className="text-[10px] leading-tight text-muted-foreground">{pct}%</div>
      )}
    </div>
  );
}

export function RecoButton({
  product,
  catalog,
  size = "xs",
  label = "ИИ",
  variant = "outline",
  className,
}: {
  product: ProductListItem;
  catalog?: ReturnType<typeof catalogContext>;
  size?: "xs" | "sm";
  label?: string;
  variant?: "outline" | "secondary" | "default";
  className?: string;
}) {
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
          brand: product.brand,
          category: product.category,
          isWeak: product.isWeak,
          salesRank30d: product.salesRank30d,
          avgDailySales: product.avgDailySales,
          daysOfCover: product.daysOfCover,
          stockQty: product.stockQty,
          inTransitToMoscow: product.inTransitToMoscow,
          priceWb: product.priceWb,
          priceDiscountedWb: product.priceDiscountedWb,
          costPrice: product.costPrice,
          marginPct: product.econ?.marginPct ?? null,
          drrPct: product.econ?.drrPct ?? null,
          profitPerUnitRub: product.econ?.profitPerUnitRub ?? null,
          photosCount: product.photos.length || (product.photoUrl ? 1 : 0),
          descriptionLength: product.description?.length ?? 0,
          sizes: product.sizes,
          catalog,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Ошибка");
      setReco(data.recommendation as ProductRecommendation);
    } catch (e) {
      toast.error(`Не удалось получить разбор: ${(e as Error).message}`);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  const f = reco?.funnel;

  return (
    <>
      <Button size={size} variant={variant} onClick={load} className={className}>
        <Sparkles className="size-3.5" />
        {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="pr-6">Разбор ИИ · {product.title}</DialogTitle>
            <DialogDescription>
              {loading
                ? "Смотрю воронку, карточку, размеры и экономику…"
                : reco?.source === "claude"
                  ? "Анализ Claude по данным кабинета"
                  : "Разбор по правилам (для Claude нужен ANTHROPIC_API_KEY)"}
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <div className="space-y-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {!loading && reco && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={`text-[11px] ${VERDICT[reco.verdict]?.className ?? ""}`}
                >
                  {VERDICT[reco.verdict]?.label ?? reco.verdict}
                </Badge>
                {product.isWeak && reco.verdict !== "weak" && (
                  <span className="text-[11px] text-muted-foreground">
                    в списке помечен как слабый
                  </span>
                )}
              </div>

              <p className="text-sm">{reco.summary}</p>

              {/* Воронка — на чём именно теряем покупателя */}
              {f && f.opens > 0 && (
                <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    Воронка карточки · {f.days} дн
                  </div>
                  <div className="flex gap-2">
                    <FunnelStep
                      label="Открыли"
                      value={f.opens}
                      hint="Сколько раз открывали карточку товара"
                    />
                    <FunnelStep
                      label="В корзину"
                      value={f.carts}
                      pct={f.cartRate}
                      hint={`${f.cartRate}% от открывших положили в корзину — низкий процент указывает на фото, цену или заголовок`}
                    />
                    <FunnelStep
                      label="Заказы"
                      value={f.orders}
                      pct={f.orderRate}
                      hint={`${f.orderRate}% корзин дошли до заказа — низкий процент чаще всего про цену`}
                    />
                    <FunnelStep
                      label="Выкупы"
                      value={f.buyouts}
                      pct={f.buyoutRate}
                      hint={`${f.buyoutRate}% заказов выкуплено — низкий процент значит возвраты: описание или размеры не совпали`}
                    />
                  </div>
                </div>
              )}

              {reco.problems.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    Что не так
                  </div>
                  {reco.problems.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <Badge
                        variant="outline"
                        className={`mt-0.5 shrink-0 text-[10px] ${SEVERITY_CLASS[p.severity] ?? ""}`}
                      >
                        {p.metric}
                      </Badge>
                      <span className="text-muted-foreground">{p.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  Что сделать
                </div>
                {reco.recommendations.map((r, i) => {
                  const area = AREA[r.area] ?? AREA.other;
                  const Icon = area.icon;
                  return (
                    <div
                      key={i}
                      className="rounded-lg border border-border/60 px-3 py-2 text-sm"
                    >
                      <div className="flex items-start gap-2">
                        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="font-medium">{r.action}</div>
                          <div className="text-xs text-muted-foreground">
                            {area.label} · {r.impact}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
