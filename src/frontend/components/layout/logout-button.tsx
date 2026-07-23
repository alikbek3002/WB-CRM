"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.push("/login");
    router.refresh();
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={logout}
      disabled={loading}
      aria-label="Выйти"
      className="text-muted-foreground hover:text-foreground"
    >
      <LogOut className="size-4" />
      Выйти
    </Button>
  );
}
