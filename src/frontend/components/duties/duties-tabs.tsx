"use client";

import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/frontend/components/ui/tabs";

// Три разных вопроса разнесены по вкладкам: «что мне делать сегодня»,
// «как устроен регламент» и «кто как его соблюдает». Раньше всё это лежало
// на странице подряд, и найти сам регламент было негде.
export function DutiesTabs({
  today,
  rules,
  discipline,
  todayCount,
  rulesCount,
}: {
  today: ReactNode;
  rules: ReactNode;
  discipline: ReactNode;
  todayCount: number;
  rulesCount: number;
}) {
  return (
    <Tabs defaultValue="today">
      <TabsList>
        <TabsTrigger value="today">Сегодня · {todayCount}</TabsTrigger>
        <TabsTrigger value="rules">Регламент · {rulesCount}</TabsTrigger>
        <TabsTrigger value="discipline">Дисциплина</TabsTrigger>
      </TabsList>

      <TabsContent value="today" className="space-y-4 pt-4">
        {today}
      </TabsContent>
      <TabsContent value="rules" className="pt-4">
        {rules}
      </TabsContent>
      <TabsContent value="discipline" className="pt-4">
        {discipline}
      </TabsContent>
    </Tabs>
  );
}
