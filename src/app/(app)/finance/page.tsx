import { Card, CardContent } from "@/frontend/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { PlanFact } from "@/frontend/components/finance/plan-fact";
import { formatRub } from "@/shared/format";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getFinanceRows, getSalesPlanView } from "@/backend/data";
import { cn } from "@/shared/utils";

export default async function FinancePage() {
  const session = await getSession();
  if (!can(session.role, "finance:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const [rows, planView] = await Promise.all([
    getFinanceRows(),
    getSalesPlanView(),
  ]);
  const canPlan = can(session.role, "finance:plan");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Финансы</h1>
        <p className="text-sm text-muted-foreground">
          План WB на полугодие против факта продаж · детализация отчётов WB
        </p>
      </div>

      <PlanFact view={planView} canPlan={canPlan} />

      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Период</TableHead>
                <TableHead className="text-right">Продажи</TableHead>
                <TableHead className="text-right">Комиссия WB</TableHead>
                <TableHead className="text-right">Логистика</TableHead>
                <TableHead className="text-right">Хранение</TableHead>
                <TableHead className="text-right">Штрафы</TableHead>
                <TableHead className="text-right">К перечислению</TableHead>
                <TableHead className="text-right">Прибыль</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    Финансовых отчётов пока нет — данные появятся после
                    синхронизации отчётов WB (reportDetailByPeriod).
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.period}>
                  <TableCell className="font-medium">{r.period}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRub(r.salesRub)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    −{formatRub(r.commissionRub)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    −{formatRub(r.logisticsRub)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    −{formatRub(r.storageRub)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    −{formatRub(r.penaltyRub)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatRub(r.toPayRub)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-medium tabular-nums",
                      r.profitRub >= 0 ? "text-emerald-400" : "text-red-400",
                    )}
                  >
                    {formatRub(r.profitRub)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
