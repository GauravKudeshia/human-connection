export function createBetaApi(fetcher = fetch, onUnauthorized = () => {}) {
  const pending = new Map();
  let generation = 0;
  async function request(url, options) {
    const started = generation;
    const response = await fetcher(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      ...options,
    });
    if (response.status === 401) {
      generation++;
      onUnauthorized();
    }
    if (started !== generation && response.status !== 401) {
      const error = new Error("The sign-in session changed. Please try again.");
      error.status = 401;
      throw error;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        "The service returned an unreadable response. Please try again.",
      );
    }
    if (response.ok && started !== generation) {
      const error = new Error("The sign-in session changed. Please try again.");
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      if (
        response.status === 403 &&
        body.error?.code === "ACCOUNT_UNAVAILABLE"
      ) {
        generation++;
        onUnauthorized();
      }
      const error = new Error(
        body.error?.message || "This request could not be completed.",
      );
      error.code = body.error?.code;
      error.status = response.status;
      throw error;
    }
    return body;
  }
  return {
    session: () => request("/api/marketplace/auth/session"),
    async logout() {
      generation++;
      const result = await request("/api/marketplace/auth/logout", {
        method: "POST",
      });
      return result;
    },
    async read(resource, id, filters = {}) {
      const query = new URLSearchParams({ resource, ...filters });
      if (id) query.set("id", id);
      return (await request("/api/marketplace?" + query)).data;
    },
    async act(action, payload = {}) {
      const fingerprint = JSON.stringify({ action, payload });
      const key = pending.get(fingerprint) || crypto.randomUUID();
      pending.set(fingerprint, key);
      try {
        const response = await request("/api/marketplace", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({ action, payload }),
        });
        pending.delete(fingerprint);
        return response.result;
      } catch (error) {
        // A network interruption can hide a successful write. Keep its key for retry.
        if (error.status && error.status < 500) pending.delete(fingerprint);
        throw error;
      }
    },
  };
}
export const money = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents || 0) / 100,
  );
export const human = (value) =>
  String(value || "")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (s) => s.toUpperCase());
