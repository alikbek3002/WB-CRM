import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import { formatNumber, formatSom } from "@/shared/format";
import { getFulfillment, getFulfillmentPartners } from "@/backend/data";
import type { Supply } from "@/shared/types";

const qtyOf = (s: Supply) => s.receivedQty ?? s.quantity;

// Вкладка «Фул-фирма» на Остатках: сколько товара сейчас в обработке у
// фул-фирмы и во что обработка обходится («приняли N шт × тариф сом/шт = сумма»).
// Данные — модуль /fulfillment (computeFulfillment), тут только срез и ссылка.
export async function FfPanel() {
  const [f, partners] = await Promise.all([
    getFulfillment(),
    getFulfillmentPartners(),
  ]);

  // «Сейчас у фул-фирмы» — принято, но ещё не распределено по складам WB
  // (f.receivedQty включает и уже распределённые карточки — он не подходит)
  const inProcessing = f.cards.filter((s) => s.status !== "distributed");
  const inProcessingQty = inProcessing.reduce((t, s) => t + qtyOf(s), 0);

  const kpis = [
    { label: "У фул-фирмы сейчас", value: formatNumber(inProcessingQty) + " шт" },
    { label: "В разборе", value: formatNumber(f.sortingQty) + " шт" },
    { label: "Лежит на складе", value: formatNumber(f.inStockQty) + " шт" },
    { label: "Начислено за услуги", value: formatSom(f.chargedRub) },
    { label: "Оплачено", value: formatSom(f.paidRub) },
    { label: "Долг фул-фирме", value: formatSom(f.owedRub) },
  ];

  // «Принято всего» по партнёру — включая распределённые: формула начисления
  // «тариф × принято» считается со всей принятой партии
  const qtyByPartner = new Map<string, number>();
  for (const s of f.cards) {
    if (!s.fulfillmentPartnerId) continue;
    qtyByPartner.set(
      s.fulfillmentPartnerId,
      (qtyByPartner.get(s.fulfillmentPartnerId) ?? 0) + qtyOf(s),
    );
  }
  const activePartners = partners.filter(
    (p) => !p.archived || (qtyByPartner.get(p.id) ?? 0) > 0,
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className="text-xl font-semibold tabular-nums">{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {activePartners.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Тарифы и начисления
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                начисление = тариф × принято, входит в себестоимость
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto px-0 pb-0">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-normal">Фул-фирма</th>
                  <th className="px-2 py-2 text-right font-normal">Тариф, сом/шт</th>
                  <th className="px-2 py-2 text-right font-normal">Принято, шт</th>
                  <th className="px-2 py-2 text-right font-normal">Начислено</th>
                  <th className="px-4 py-2 text-right font-normal">Долг</th>
                </tr>
              </thead>
              <tbody>
                {activePartners.map((p) => (
                  <tr key={p.id} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2 font-medium">{p.name}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatSom(p.ratePerUnitRub)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatNumber(qtyByPartner.get(p.id) ?? 0)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatSom(p.chargedRub)}
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${
                        p.owedRub > 0 ? "text-amber-400" : "text-muted-foreground"
                      }`}
                    >
                      {formatSom(p.owedRub)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center text-sm">
            Партии в обработке
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {formatNumber(inProcessing.length)} партий ·{" "}
              {formatNumber(inProcessingQty)} шт
            </span>
            <Link
              href="/fulfillment"
              className="ml-auto flex items-center gap-1 text-xs font-normal text-primary hover:underline"
            >
              Модуль «Фул-фирма»
              <ArrowRight className="size-3" />
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {inProcessing.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Сейчас у фул-фирмы ничего нет — партии появятся после приёмки
              поставки.
            </p>
          )}
          {inProcessing.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {s.fulfillmentPartnerName ?? "фул-фирма не указана"}
                  {s.shortage > 0 &&
                    ` · недостача ${formatNumber(s.shortage)} шт`}
                </span>
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {s.statusLabel}
              </Badge>
              <span className="w-24 text-right text-sm tabular-nums">
                {formatNumber(qtyOf(s))} шт
              </span>
              <span
                className="w-28 text-right text-sm tabular-nums"
                title="Начислено фул-фирме за партию (факт или тариф × принято)"
              >
                {s.fulfillmentRub > 0 ? formatSom(s.fulfillmentRub) : "—"}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
