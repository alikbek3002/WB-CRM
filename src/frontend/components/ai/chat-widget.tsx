"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/frontend/components/ui/button";
import { cn } from "@/shared/utils";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Какой товар продаётся лучше всего?",
  "Что скоро закончится на складах?",
  "Выполняем ли план продаж?",
  "Какие у меня задачи на сегодня?",
];

export function ChatWidget({ userName }: { userName: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || loading) return;
    const next = [...messages, { role: "user" as const, content: q }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-20) }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error === "ai_not_configured"
            ? "ИИ не подключён (нет ключа)"
            : "Не удалось получить ответ",
        );
      }
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${(e as Error).message}` }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Плавающая кнопка */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="ИИ-ассистент"
        className={cn(
          "fixed bottom-5 right-5 z-50 flex size-13 items-center justify-center rounded-full shadow-lg transition",
          "bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white hover:scale-105",
          "size-14",
        )}
      >
        {open ? <X className="size-6" /> : <Sparkles className="size-6" />}
      </button>

      {/* Панель чата */}
      {open && (
        <div className="fixed bottom-24 right-5 z-50 flex h-[min(600px,75vh)] w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
          <div className="flex items-center gap-2 border-b border-border bg-gradient-to-r from-violet-500/10 to-fuchsia-600/10 px-4 py-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white">
              <Bot className="size-4.5" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">ИИ-ассистент</div>
              <div className="text-[11px] text-muted-foreground">по вашему магазину WB</div>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Привет, {userName.split(" ")[0]}! Спросите про товары, остатки, план продаж
                  или свои задачи — отвечу по актуальным данным магазина.
                </p>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="rounded-lg border border-border/60 px-3 py-2 text-left text-sm transition hover:border-border hover:bg-muted/40"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm",
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border/60 bg-muted/30",
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  Думаю…
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t border-border p-2.5"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Спросите что-нибудь…"
              className="min-w-0 flex-1 rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <Button type="submit" size="icon" disabled={loading || !input.trim()} aria-label="Отправить">
              <Send className="size-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  );
}
