import { redirect } from "next/navigation";
import { LoginForm } from "@/frontend/components/auth/login-form";
import { getSession } from "@/backend/auth/session";

export const dynamic = "force-dynamic";

// Вход в личный кабинет. Уже авторизованных отправляем на дашборд.
export default async function LoginPage() {
  const session = await getSession();
  if (session.authenticated) redirect("/dashboard");

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-lg font-bold text-white">
            WB
          </div>
          <h1 className="text-xl font-semibold tracking-tight">WB CRM</h1>
          <p className="text-sm text-muted-foreground">
            Вход в личный кабинет сотрудника
          </p>
        </div>
        <LoginForm />
        <p className="text-center text-xs text-muted-foreground">
          Логин и пароль выдаёт директор. Забыли пароль — обратитесь к руководителю.
        </p>
      </div>
    </div>
  );
}
