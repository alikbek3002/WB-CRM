import { Avatar, AvatarFallback } from "@/frontend/components/ui/avatar";
import { Badge } from "@/frontend/components/ui/badge";
import { Button } from "@/frontend/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/frontend/components/ui/card";
import { Input } from "@/frontend/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/frontend/components/ui/table";
import { NoAccess } from "@/frontend/components/layout/no-access";
import { can, isMemberRole, ROLE_LABELS } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import { getTeam } from "@/backend/data";

export default async function TeamPage() {
  const session = await getSession();
  if (!can(session.role, "team:manage")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const team = await getTeam();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Команда</h1>
        <p className="text-sm text-muted-foreground">
          Участники организации и роли (RBAC, раздел 5 плана)
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Пригласить по email</CardTitle>
          <CardDescription>
            Приглашение действует 7 дней (таблица invites). Отправка станет
            доступна после подключения Supabase.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex max-w-md gap-2">
            <Input
              type="email"
              placeholder="colleague@company.ru"
              disabled={session.isDemo}
            />
            <Button type="submit" disabled={session.isDemo}>
              Пригласить
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Участник</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Роль</TableHead>
                <TableHead>В команде с</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="size-7">
                        <AvatarFallback className="text-[10px]">
                          {m.name
                            .split(" ")
                            .map((w) => w[0])
                            .slice(0, 2)
                            .join("")}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{m.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.email}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={m.role === "owner" ? "default" : "secondary"}
                      className="text-[10px]"
                    >
                      {isMemberRole(m.role) ? ROLE_LABELS[m.role] : m.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(m.joinedAt).toLocaleDateString("ru-RU")}
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
