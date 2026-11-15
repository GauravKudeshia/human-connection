import { marketplaceStorage } from "../../../../lib/marketplace/http-context";
import { createVisitorHttp } from "../../../../lib/marketplace/visitor-http.mjs";
export const POST = createVisitorHttp({ storageFor: marketplaceStorage });
