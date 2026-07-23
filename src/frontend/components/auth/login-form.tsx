"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LogIn } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import { Card, CardContent } from "@/frontend/components/ui/card";
import { Input } from "@/frontend/components/ui/input";
import { Label } from "@/frontend/components/ui/label";

export function LoginForm() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!login.trim() || !password) {
      toast.error("Введите логин и пароль");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: login.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error === "invalid_credentials"
            ? "Неверный логин или пароль"
            : "Ошибка входа — попробуйте ещё раз",
        );
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="login">Логин</Label>
            <Input
              id="login"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="например, felix"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Пароль</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" disabled={loading}>
            <LogIn className="size-4" />
            {loading ? "Вход…" : "Войти"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
