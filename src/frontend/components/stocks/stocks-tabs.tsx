"use client";

import type { ReactNode } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/frontend/components/ui/tabs";

// Вкладки «Остатков»: FBO (склады WB) / FBS (личные склады) / Фул-фирма.
// Панели приходят готовыми серверными ReactNode — здесь только переключение.
// URL обновляем через replaceState (без RSC-перерендера): ?tab=fbs|ff,
// остальные параметры (общие category/brand/product фильтры) не трогаем.
export function StocksTabs({
  defaultTab,
  fbo,
  fbs,
  ff,
}: {
  defaultTab: "fbo" | "fbs" | "ff";
  fbo: ReactNode;
  fbs: ReactNode;
  ff: ReactNode | null; // null — нет права fulfillment:view, вкладку прячем
}) {
  return (
    <Tabs
      defaultValue={defaultTab}
      onValueChange={(v) => {
        const url = new URL(window.location.href);
        if (v === "fbo") url.searchParams.delete("tab");
        else url.searchParams.set("tab", String(v));
        window.history.replaceState(null, "", url.toString());
      }}
    >
      <TabsList>
        <TabsTrigger value="fbo">FBO · склады WB</TabsTrigger>
        <TabsTrigger value="fbs">FBS · свои склады</TabsTrigger>
        {ff !== null && <TabsTrigger value="ff">Фул-фирма</TabsTrigger>}
      </TabsList>
      <TabsContent value="fbo" className="pt-1">
        {fbo}
      </TabsContent>
      <TabsContent value="fbs" className="pt-1">
        {fbs}
      </TabsContent>
      {ff !== null && (
        <TabsContent value="ff" className="pt-1">
          {ff}
        </TabsContent>
      )}
    </Tabs>
  );
}
