"use client";
import { useEffect, useState } from "react";

export function useResource(
  api,
  resource,
  id,
  revision,
  filters,
  pollInterval = 8000,
) {
  const [snapshot, setSnapshot] = useState({ key: null, data: null, error: "" });
  const filterKey = JSON.stringify(filters || {});
  const resourceKey = resource + "|" + (id || "") + "|" + filterKey;
  useEffect(() => {
    let current = true;
    let timer;
    async function load() {
      try {
        const result = await api.read(resource, id, JSON.parse(filterKey));
        if (current)
          setSnapshot({ key: resourceKey, data: result, error: "" });
      } catch (issue) {
        if (current)
          setSnapshot((previous) => ({
            key: resourceKey,
            // A temporary polling failure should not unmount an active call.
            data:
              previous.key === resourceKey &&
              (!issue.status || issue.status >= 500 || issue.status === 429)
                ? previous.data
                : null,
            error: issue.message,
          }));
      } finally {
        if (current && pollInterval > 0) timer = setTimeout(load, pollInterval);
      }
    }
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, resource, id, revision, filterKey, resourceKey, pollInterval]);
  return {
    data: snapshot.key === resourceKey ? snapshot.data : null,
    error: snapshot.key === resourceKey ? snapshot.error : "",
    loading: snapshot.key !== resourceKey,
  };
}
