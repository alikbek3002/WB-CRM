import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Клиентский кэш роутера. По умолчанию в Next 15 динамические страницы имеют
  // staleTime 0: возврат на вкладку, где ты был секунду назад, снова идёт на
  // сервер за RSC-пейлоадом. С этим значением повторный заход в течение 3 минут
  // рисуется мгновенно из памяти браузера — сеть не трогается вообще.
  // Свежесть после изменений не страдает: все формы после мутации зовут
  // router.refresh(), а он сбрасывает этот кэш целиком.
  experimental: {
    staleTimes: { dynamic: 180, static: 300 },
    // Баррель-импорты (`import { Boxes, Wallet } from "lucide-react"`) без этого
    // тянут в бандл весь пакет иконок и графиков.
    optimizePackageImports: ["lucide-react", "recharts", "@base-ui/react"],
  },

  // Заголовки ответа с версией Next наружу не отдаём
  poweredByHeader: false,
};

export default nextConfig;
