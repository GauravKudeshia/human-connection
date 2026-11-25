import { marketplaceContext } from "../../../../lib/marketplace/http-context";
import { createOnboarding } from "../../../../lib/marketplace/onboarding.mjs";
import { MarketplaceError } from "../../../../lib/marketplace/errors.mjs";
import { createExperienceService } from "../../../../lib/marketplace/experience.mjs";
import { consumeQuota } from "../../../../lib/marketplace/http-router.mjs";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const limit = 12 * 1024 * 1024;
function failure(error: unknown) {
  if (error instanceof MarketplaceError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers },
    );
  return Response.json(
    {
      error: {
        code: "MEDIA_UNAVAILABLE",
        message: "Introduction media is temporarily unavailable.",
      },
    },
    { status: 503, headers },
  );
}
async function context(request: Request) {
  const value = await marketplaceContext(request);
  const config = value.config as unknown as Record<string, unknown>;
  return {
    ...value,
    onboarding: createOnboarding(value.db, {
      authorize: value.service.authorize,
      bucket: config.MARKETPLACE_MEDIA,
    }),
    experience: createExperienceService(value.db, {
      authorize: value.service.authorize,
      service: value.service,
      bucket: config.MARKETPLACE_MEDIA,
    }),
  };
}
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const value = await context(request);
    await consumeQuota(value.db, value.actor.id, "media-read", 1200);
    const media =
      params.get("kind") === "photo"
        ? await value.experience.photo(value.actor, params.get("id"))
        : await value.onboarding.media(value.actor, params.get("id"), params.get("kind") === "captions");
    if (params.get("metadata") === "1")
      return Response.json(
        {
          contentType: media.contentType,
          transcript: "transcript" in media ? media.transcript : undefined,
        },
        { headers },
      );
    return new Response(media.body, {
      headers: {
        ...headers,
        "Content-Type": media.contentType,
        "Content-Length": String(media.byteLength),
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin)
      throw new MarketplaceError(
        "ORIGIN_DENIED",
        "This request origin is not permitted.",
        403,
      );
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new MarketplaceError("JSON_REQUIRED", "JSON is required.", 415);
    const value = await marketplaceContext(request);
    await consumeQuota(value.db, value.actor.id, "media-upload", 12);
    const config = value.config as unknown as Record<string, unknown>;
    const service = createOnboarding(value.db, {
      authorize: value.service.authorize,
      bucket: config.MARKETPLACE_MEDIA,
    });
    const reader = request.body?.getReader();
    if (!reader)
      throw new MarketplaceError(
        "VALIDATION",
        "An introduction is required.",
        400,
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new MarketplaceError(
          "TOO_LARGE",
          "Introduction data exceeds the upload limit.",
          413,
        );
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new MarketplaceError("VALIDATION", "Valid JSON is required.", 400);
    }
    if (
      !body ||
      typeof body.base64 !== "string" ||
      body.base64.length > 11184812 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        body.base64,
      )
    )
      throw new MarketplaceError(
        "INVALID_MEDIA",
        "Provide valid base64 introduction media.",
        400,
      );
    const binary = atob(body.base64);
    const mediaBytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const payload = {
      bytes: mediaBytes,
      contentType: body.contentType,
      transcript: body.transcript,
      consent: body.consent,
      durationSeconds: body.durationSeconds,
      captions: body.captions,
      altText: body.altText,
    };
    const result =
      body.kind === "photo"
        ? await createExperienceService(value.db, {
            authorize: value.service.authorize,
            service: value.service,
            bucket: config.MARKETPLACE_MEDIA,
          }).uploadPhoto(
            value.actor,
            payload,
            request.headers.get("idempotency-key"),
          )
        : await service.uploadIntro(
            value.actor,
            payload,
            request.headers.get("idempotency-key"),
          );
    return Response.json({ result, mode: "staging" }, { headers });
  } catch (error) {
    return failure(error);
  }
}
