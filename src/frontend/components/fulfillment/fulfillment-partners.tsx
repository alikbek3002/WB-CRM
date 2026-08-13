"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/frontend/components/ui/dialog";
import { Input } from "@/frontend/components/ui/input";
import { Label } from "@/frontend/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import { formatNumber, formatSom } from "@/shared/format";
import type { FulfillmentPartner } from "@/shared/types";

// Тариф за единицу — база начисления за разбор поставки. Начисление входит
// в себестоимость товара (не в расходы периода), поэтому правка тарифа НЕ
// пересчитывает уже принятые партии: их себестоимость зафиксирована приёмкой.
function PartnerForm({
  partner,
  cities,
}: {
  partner?: FulfillmentPartner;
  cities: string[]; // подсказки городов: свои склады в кабинете WB + уже заведённые фул-фирмы
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(partner?.name ?? "");
  const [rate, setRate] = useState(String(partner?.ratePerUnitRub ?? ""));
  const [city, setCity] = useState(partner?.city ?? "");
  const [note, setNote] = useState(partner?.note ?? "");

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/fulfillment/partners", {
        method: partner ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(partner ? { id: partner.id } : {}),
          name: name.trim(),
          ratePerUnitRub: Number(rate) || 0,
          city: city.trim() || null,
          note: note.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error === "duplicate_name" ? "Такая фул-фирма уже заведена" : "Ошибка",
        );
      }
      toast.success(partner ? "Тариф обновлён" : "Фул-фирма добавлена");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size={partner ? "xs" : "sm"} variant="outline" onClick={() => setOpen(true)}>
        {partner ? "Тариф" : <><Plus className="size-3.5" /> Добавить</>}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{partner ? `Тариф · ${partner.name}` : "Новая фул-фирма"}</DialogTitle>
            <DialogDescription>
              Тариф за единицу — сколько платим за приёмку, разбор и упаковку одной штуки.
              Он входит в себестоимость товара.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Название</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Фул-фирма Москва" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Тариф, сом за единицу</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="15"
              />
            </div>
            {/* Город разгрузки: по нему карточка поставки предлагает, куда
                приедет карго. Подсказки — города своих складов в кабинете WB
                (их WB отдаёт по офисам), чтобы не плодить «Спб» рядом с
                «Санкт-Петербургом». */}
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Город разгрузки</Label>
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Москва"
              />
              {cities.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {cities.map((c) => (
                    <Button
                      key={c}
                      size="xs"
                      variant={city.trim() === c ? "default" : "outline"}
                      onClick={() => setCity(c)}
                    >
                      {c}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Заметка</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" />
            </div>
            <Button onClick={save} disabled={saving || !name.trim()} className="w-full">
              {saving ? "Сохраняю…" : "Сохранить"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function FulfillmentPartners({
  partners,
  cities,
  canManage,
}: {
  partners: FulfillmentPartner[];
  cities: string[];
  canManage: boolean;
}) {
  const active = partners.filter((p) => !p.archived);

  return (
    <Card className="py-0">
      <CardContent className="space-y-3 px-4 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Фул-фирмы и тарифы</div>
            <div className="text-xs text-muted-foreground">
              Начисление за поставку = тариф × принято. Входит в себестоимость единицы.
            </div>
          </div>
          {canManage && <PartnerForm cities={cities} />}
        </div>

        {active.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Фул-фирма ещё не заведена.
            {canManage
              ? " Добавьте её с тарифом — и услуги разбора начнут попадать в себестоимость."
              : " Её заводит директор."}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Фул-фирма</TableHead>
                <TableHead>Город</TableHead>
                <TableHead className="text-right">Тариф, сом/шт</TableHead>
                <TableHead className="text-right">Поставок</TableHead>
                <TableHead className="text-right">Начислено</TableHead>
                <TableHead className="text-right">Оплачено</TableHead>
                <TableHead className="text-right">Долг</TableHead>
                {canManage && <TableHead className="text-right" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="font-medium">{p.name}</span>
                    {p.note && (
                      <span className="block text-xs text-muted-foreground">{p.note}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.city ?? "—"}
                    {p.fbsWarehouseName && (
                      <span className="block text-[11px]">склад WB: {p.fbsWarehouseName}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.ratePerUnitRub > 0 ? formatSom(p.ratePerUnitRub) : (
                      <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-400">
                        не задан
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(p.suppliesCount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatSom(p.chargedRub)}</TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-400">
                    {formatSom(p.paidRub)}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${p.owedRub > 0 ? "text-amber-400" : "text-muted-foreground"}`}
                  >
                    {formatSom(p.owedRub)}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <PartnerForm partner={p} cities={cities} />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
