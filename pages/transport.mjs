import {
  initialState,
  applyAction,
  expire,
  summarize,
} from "../lib/engine.mjs";

// A visitor's sessionStorage is isolated by tab. No business data goes over the network.
export function makeBrowserRequest(storage, key, clock = Date.now) {
  let memory = initialState();
  let storageBlocked = false;
  function storageError() {
    const error = new Error(
      "This tab could not save your change. Continue in temporary mode and try again.",
    );
    error.code = "STORAGE_UNAVAILABLE";
    error.status = 507;
    return error;
  }
  function read() {
    if (storageBlocked || !storage) return structuredClone(memory);
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const state = JSON.parse(raw);
        if (state.schema !== 1 || !Array.isArray(state.bookings))
          throw new Error("Cannot read this demo session.");
        memory = state;
      }
    } catch {
      storageBlocked = true;
    }
    return structuredClone(memory);
  }
  function save(state) {
    if (storageBlocked) throw storageError();
    try {
      if (storage) storage.setItem(key, JSON.stringify(state));
    } catch {
      storageBlocked = true;
      throw storageError();
    }
    memory = structuredClone(state);
  }
  function view(state) {
    return {
      ...summarize(state, clock()),
      viewer: { name: "Demo guest" },
      storageStatus: storageBlocked
        ? "blocked"
        : storage
          ? "saved"
          : "temporary",
    };
  }
  return async (path, options = {}) => {
    try {
      const current = read();
      const before = JSON.stringify(current);
      expire(current, clock());
      if (!storageBlocked && JSON.stringify(current) !== before) save(current);
      if (
        path === "/api/state" &&
        (!options.method || options.method === "GET")
      ) {
        return Response.json(view(current));
      }
      if (path !== "/api/action" || options.method !== "POST")
        return Response.json(
          { error: { message: "Unknown demo action." } },
          { status: 404 },
        );
      const body = JSON.parse(options.body);
      if (!body || typeof body !== "object" || Array.isArray(body))
        return Response.json(
          { error: { message: "Invalid request." } },
          { status: 400 },
        );
      const { action, payload } = body;
      if (action === "continue-in-memory") {
        storage = null;
        storageBlocked = false;
        save(current);
        return Response.json({
          state: view(current),
          result: { storageRecovered: true },
        });
      }
      if (storageBlocked) throw storageError();
      const { state, result } = applyAction(
        current,
        action,
        payload,
        new Headers(options.headers).get("Idempotency-Key"),
        clock(),
      );
      save(state);
      return Response.json({ state: view(state), result });
    } catch (error) {
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message || "Unable to open this demo tab.",
          },
        },
        { status: error.status || 400 },
      );
    }
  };
}
