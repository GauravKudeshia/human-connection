import { createOperations } from "./operations.mjs";
import { boundedJson } from "./http-handlers.mjs";
import { MarketplaceError, requireCondition as need } from "./errors.mjs";
import { PRIVATE_HEADERS } from "./http-router.mjs";
const name = "hc_visit";
export function createVisitorHttp({ storageFor, clock = Date.now }) {
  return async (request) => {
    const secure = new URL(request.url).protocol === "https:",
      cookie = (value) =>
        `${name}=${value}; Path=/api/marketplace; HttpOnly; SameSite=Lax; Max-Age=${value ? "86400" : "0"}${secure ? "; Secure" : ""}`;
    try {
      need(
        request.method === "POST",
        "METHOD_NOT_ALLOWED",
        "Use a same-origin POST request.",
        405,
      );
      need(
        request.headers.get("origin") === new URL(request.url).origin,
        "ORIGIN_DENIED",
        "This request origin is not permitted.",
        403,
      );
      const { db } = await storageFor(request),
        service = createOperations(db, { clock });
      const body = await boundedJson(request, 1024);
      need(
        body && typeof body.action === "string",
        "VALIDATION",
        "Choose a visit measurement action.",
        400,
      );
      const token = request.headers
        .get("cookie")
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(name + "="))
        ?.slice(name.length + 1);
      let result, header;
      if (body.action === "start") {
        // A global cap bounds anonymous storage without collecting IP addresses or user agents.
        const recent = await db
          .prepare(
            "SELECT COUNT(*) n FROM mp_visit_sessions WHERE started_at>=?",
          )
          .bind(clock() - 60000)
          .first();
        need(
          recent.n < 1000,
          "RATE_LIMITED",
          "Visit measurement is temporarily busy.",
          429,
        );
        const visit = await service.startVisitor({
          consent: body.consent,
          consentVersion: body.consentVersion,
          token,
        });
        header = cookie(visit.token);
        result = { consented: true, expiresAt: visit.expiresAt };
      } else if (body.action === "select")
        result = await service.recordVisitor(
          token,
          { name: "experience_selected" },
          request.headers.get("idempotency-key"),
        );
      else if (body.action === "forget") {
        result = await service.forgetVisitor(token);
        header = cookie("");
      } else
        throw new MarketplaceError(
          "VALIDATION",
          "Choose a visit measurement action.",
          400,
        );
      return Response.json(
        { result },
        {
          headers: {
            ...PRIVATE_HEADERS,
            ...(header ? { "Set-Cookie": header } : {}),
          },
        },
      );
    } catch (error) {
      const known = error instanceof MarketplaceError;
      return Response.json(
        {
          error: {
            code: known ? error.code : "INTERNAL_ERROR",
            message: known
              ? error.message
              : "Visit measurement is unavailable.",
          },
        },
        { status: known ? error.status : 500, headers: PRIVATE_HEADERS },
      );
    }
  };
}
