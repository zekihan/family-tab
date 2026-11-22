import assert from "node:assert/strict";
import test from "node:test";
import { AuthError, createApi, NetworkError, ServerError } from "../../src/data/api.ts";
import { withSyncLock } from "../../src/data/lock.ts";
import { deferred } from "./helpers.ts";

test("fetch client carries the same-origin credentials and custom header and distinguishes failures", async () => {
  const api = createApi(async (path, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("X-Family-Tab"), "1");
    switch (path) {
      case "/healthz": return new Response("ok");
      case "/api/me": return Response.json({ error: "unauthenticated" }, { status: 401 });
      case "/api/snapshot": throw new TypeError("disconnected");
      case "/api/logout":
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, undefined);
      return new Response(null, { status: 204 });
      default: return Response.json({ error: "bad", message: "Invalid" }, { status: 403 });
    }
  });
  assert.equal(await api.health(), "ok");
  await api.logout();
  await assert.rejects(api.me(), AuthError);
  await assert.rejects(api.snapshot(), NetworkError);
  await assert.rejects(api.receipts([]), { name: "ServerError", status: 403, code: "bad" } as Partial<ServerError>);
});

test("lock fallback serializes work and releases the lock after failure", async () => {
  const events: string[] = [];
  const release = deferred<void>();
  const one = withSyncLock(async () => {
    events.push("first");
    await release.promise;
    events.push("failed");
    throw new Error("Failure");
  }, null);
  const two = withSyncLock(async () => { events.push("second"); }, null);
  await Promise.resolve();
  assert.deepEqual(events, ["first"]);
  release.resolve();
  await assert.rejects(one, /Failure/);
  await two;
  assert.deepEqual(events, ["first", "failed", "second"]);
});
