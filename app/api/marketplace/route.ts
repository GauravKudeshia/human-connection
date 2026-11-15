import { marketplaceContext } from "../../../lib/marketplace/http-context";
import { createMarketplaceHttp } from "../../../lib/marketplace/http-router.mjs";
const handle = createMarketplaceHttp({ contextFor: marketplaceContext });
export const GET = handle;
export const POST = handle;
