import { NoAccess } from "@/frontend/components/layout/no-access";
import { FboPanel } from "@/frontend/components/stocks/fbo-panel";
import { FbsPanel } from "@/frontend/components/stocks/fbs-panel";
import { FfPanel } from "@/frontend/components/stocks/ff-panel";
import { StocksTabs } from "@/frontend/components/stocks/stocks-tabs";
import { can } from "@/shared/rbac";
import { getSession } from "@/backend/auth/session";
import {
  getFbsStocks,
  getProductList,
  getStocksOverview,
  getWbIncomes,
} from "@/backend/data";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Остатки в трёх разрезах-вкладках: FBO (склады WB, фильтры в URL),
// FBS (личные склады продавца из marketplace-api) и Фул-фирма (товар в
// обработке × тариф — срез модуля /fulfillment).
export default async function StocksPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    category?: string;
    brand?: string;
    product?: string;
  }>;
}) {
  const session = await getSession();
  if (!can(session.role, "products:view")) {
    return <NoAccess roleLabel={session.roleLabel} />;
  }

  const params = await searchParams;
  const showFf = can(session.role, "fulfillment:view");
  const tab =
    params.tab === "fbs" ? "fbs" : params.tab === "ff" && showFf ? "ff" : "fbo";

  const productId = params.product && UUID.test(params.product) ? params.product : null;

  const [overview, products, wbIncomes, fbs] = await Promise.all([
    getStocksOverview(),
    getProductList(),
    getWbIncomes(),
    getFbsStocks(),
  ]);

  const category =
    params.category && products.some((p) => p.category === params.category)
      ? params.category
      : "all";
  const brand =
    params.brand && products.some((p) => p.brand === params.brand)
      ? params.brand
      : "all";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Остатки</h1>
        <p className="text-sm text-muted-foreground">
          FBO — склады Wildberries · FBS — личные склады
          {showFf && " · Фул-фирма — товар в обработке"}
        </p>
      </div>

      <StocksTabs
        defaultTab={tab}
        fbo={
          <FboPanel
            overview={overview}
            products={products}
            wbIncomes={wbIncomes}
            category={category}
            brand={brand}
            productId={productId}
          />
        }
        fbs={<FbsPanel view={fbs} />}
        ff={showFf ? <FfPanel /> : null}
      />
    </div>
  );
}
