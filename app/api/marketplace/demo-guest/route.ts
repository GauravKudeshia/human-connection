import { marketplaceStorage } from "../../../../lib/marketplace/http-context";
import { createGuestInvitationHttp } from "../../../../lib/marketplace/guest-invitation-http.mjs";

const handle = createGuestInvitationHttp({ storage: marketplaceStorage });

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
