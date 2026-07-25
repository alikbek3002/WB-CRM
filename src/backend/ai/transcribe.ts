// Распознавание речи для голосовых сообщений Telegram.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ПРОВАЙДЕР: Claude (наш ИИ-ассистент) принимает текст,
// изображения и PDF, но НЕ аудио — транскрибировать голосовые им нельзя.
// Поэтому речь → текст делает Whisper (OpenAI), а дальше текст уходит в
// обычный агент-цикл Claude, как если бы сотрудник напечатал его руками.
//
// Без OPENAI_API_KEY функция не падает: бот вежливо просит написать текстом.
// Чистый модуль (fetch + относительные импорты) — работает и в боте (tsx).

// ── Провайдер выбирается автоматически по наличию ключа ─────────────────────
// GROQ_API_KEY — бесплатный тариф (2000 запросов/сутки), Whisper large-v3-turbo,
//   API полностью OpenAI-совместим → тот же код, другой базовый URL.
// OPENAI_API_KEY — платный запасной вариант (~$0.006/мин).
// Ни одного ключа — бот вежливо просит написать текстом.
type Provider = { url: string; key: string; model: string; label: string };

function pickProvider(): Provider | null {
  const groq = process.env.GROQ_API_KEY?.trim();
  if (groq) {
    return {
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      key: groq,
      model: process.env.TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo",
      label: "groq",
    };
  }
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    return {
      url: "https://api.openai.com/v1/audio/transcriptions",
      key: openai,
      model: process.env.TRANSCRIBE_MODEL?.trim() || process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1",
      label: "openai",
    };
  }
  return null;
}

// Голосовые длиннее этого не принимаем: лимит провайдеров (25 МБ у Groq на
// бесплатном тарифе) и здравый смысл — задача голосом укладывается в пару минут.
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 600;

export function transcribeConfigured(): boolean {
  return pickProvider() !== null;
}

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: "not_configured" | "too_long" | "download_failed" | "api_error"; message: string };

// Скачивание файла Telegram по file_id (getFile → file_path → download).
async function downloadTelegramFile(fileId: string): Promise<ArrayBuffer | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const meta = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!meta.ok) return null;
  const json = (await meta.json()) as { ok: boolean; result?: { file_path?: string } };
  const path = json.result?.file_path;
  if (!json.ok || !path) return null;

  const file = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!file.ok) return null;
  return file.arrayBuffer();
}

// Голосовое Telegram → текст. fileId/duration берутся из ctx.message.voice.
export async function transcribeTelegramVoice(
  fileId: string,
  durationSec: number,
  mimeType = "audio/ogg",
): Promise<TranscribeResult> {
  const provider = pickProvider();
  if (!provider) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Распознавание голоса не подключено — напишите, пожалуйста, текстом.",
    };
  }
  if (durationSec > MAX_SECONDS) {
    return {
      ok: false,
      reason: "too_long",
      message: `Голосовое длиннее ${Math.round(MAX_SECONDS / 60)} мин — отправьте покороче или напишите текстом.`,
    };
  }

  let audio: ArrayBuffer | null;
  try {
    audio = await downloadTelegramFile(fileId);
  } catch (e) {
    console.error("[transcribe] download:", e);
    audio = null;
  }
  if (!audio) {
    return { ok: false, reason: "download_failed", message: "Не удалось скачать голосовое, попробуйте ещё раз." };
  }
  if (audio.byteLength > MAX_BYTES) {
    return { ok: false, reason: "too_long", message: "Голосовое слишком большое — отправьте покороче." };
  }

  // Расширение важно: Whisper определяет формат по имени файла.
  const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `voice.${ext}`);
  form.append("model", provider.model);
  form.append("language", "ru"); // кабинет русскоязычный — точность заметно выше
  form.append("response_format", "json");

  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[transcribe] ${provider.label} ${res.status}:`, body.slice(0, 300));
      // 429 у Groq — исчерпан бесплатный дневной лимит: говорим об этом честно
      return {
        ok: false,
        reason: "api_error",
        message:
          res.status === 429
            ? "Лимит распознавания голоса на сегодня исчерпан — напишите текстом."
            : "Не смог распознать голосовое, попробуйте ещё раз или напишите текстом.",
      };
    }
    const data = (await res.json()) as { text?: string };
    const text = (data.text ?? "").trim();
    if (!text) {
      return { ok: false, reason: "api_error", message: "В голосовом не разобрал слов — попробуйте записать ещё раз." };
    }
    return { ok: true, text };
  } catch (e) {
    console.error("[transcribe] request:", e);
    return {
      ok: false,
      reason: "api_error",
      message: "Распознавание временно недоступно — напишите, пожалуйста, текстом.",
    };
  }
}
