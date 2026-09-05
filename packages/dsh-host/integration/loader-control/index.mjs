/**
 * Test-only Cordis fixture used by the pinned real-Web integration gate.
 * It is never referenced by a shipped profile. The authenticated POST removes
 * one explicitly named Loader entry through DSH's public Entry lifecycle so
 * the test can observe real Host teardown without editing config or internals.
 */

export const name = "gatherthread-dsh-loader-control-fixture";
export const inject = ["loader", "connection", "clientModules"];

export function apply(context, config) {
  const targetId = safeId(config?.targetId);
  let saved;
  context.connection.fetch.register({
    path: "/api/gatherthread.test-client-reload",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      if (request.method !== "POST" || new URL(request.url).search !== "") {
        return response({ ok: false }, 400);
      }
      const revision = context.clientModules.rebuilt("@gatherthread/dsh-host");
      return revision === undefined
        ? response({ ok: false }, 404)
        : response({ ok: true, revision }, 200);
    },
  });
  context.connection.fetch.register({
    path: "/api/gatherthread.test-unload",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      if (request.method !== "POST" || new URL(request.url).search !== "") {
        return response({ ok: false }, 400);
      }
      const target = [...context.loader.entries()].find((entry) => entry.options.id === targetId);
      if (target === undefined || target.disabled || saved !== undefined) return response({ ok: false }, 404);
      const resolvedId = target.id;
      const previousDisabled = Object.hasOwn(target.options, "disabled")
        ? target.options.disabled
        : undefined;
      await target.update({ disabled: true });
      saved = { target, previousDisabled };
      const active = [...context.loader.entries()].filter((entry) => (
        entry.options.id === targetId && entry.fiber !== undefined && !entry.disabled
      )).length;
      return response({ ok: true, resolvedId, active }, 200);
    },
  });
  context.connection.fetch.register({
    path: "/api/gatherthread.test-reload",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      if (request.method !== "POST" || new URL(request.url).search !== "" || saved === undefined) {
        return response({ ok: false }, 400);
      }
      const { target, previousDisabled } = saved;
      await target.update({ disabled: previousDisabled ?? null });
      saved = undefined;
      const active = [...context.loader.entries()].filter((entry) => (
        entry.options.id === targetId && entry.fiber !== undefined && !entry.disabled
      )).length;
      return response({ ok: true, active }, 200);
    },
  });
}

function safeId(value) {
  if (typeof value !== "string" || !/^gatherthread-dsh-[a-f0-9]{24}$/u.test(value)) {
    throw new Error("loader-control fixture requires one GatherThread Loader entry id");
  }
  return value;
}

function response(value, status) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
