import { revalidateTag } from "next/cache";
import { WB_DATA_TAG } from "./index";

// Сброс кэша чтения (см. cachedRead в ./index). Вызывать в API-роутах и Server
// Actions ПОСЛЕ успешной записи в БД — тогда следующий рендер/refresh страницы
// возьмёт свежие данные, а не закэшированные. Вызов из обычного RSC-рендера
// недопустим (Next бросит ошибку) — только из мутационного контекста.
export function invalidateWbData(): void {
  revalidateTag(WB_DATA_TAG);
}
