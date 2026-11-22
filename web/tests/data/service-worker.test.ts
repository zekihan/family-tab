import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { ensureLatestApp } from "../../src/data/service-worker.ts";
import { deferred } from "./helpers.ts";

function browser(t: TestContext) {
  const original = {};
  const registration = { update: async () => {}, installing: null as EventTarget | null, waiting: null };
  const serviceWorker = Object.assign(new EventTarget(), { controller: original, register: async () => registration });
  const reload = t.mock.fn();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true, serviceWorker } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { reload } });
  t.after(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else Reflect.deleteProperty(globalThis, "location");
  });
  const activate = () => {
    serviceWorker.controller = {};
    serviceWorker.dispatchEvent(new Event("controllerchange"));
  };
  return { registration, activate, reload };
}

test("online startup waits through a slow service worker check and installation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registration, activate, reload } = browser(t);
  const entered = deferred<void>();
  const checked = deferred<void>();
  registration.update = () => {
    entered.resolve();
    return checked.promise;
  };
  let finished = false;
  const startup = ensureLatestApp().then(result => {
    finished = true;
    return result;
  });
  await entered.promise;
  t.mock.timers.tick(3001);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  const worker = Object.assign(new EventTarget(), { state: "installing", postMessage: t.mock.fn() });
  registration.installing = worker;
  checked.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(worker.postMessage.mock.callCount(), 0);
  worker.state = "installed";
  worker.dispatchEvent(new Event("statechange"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(worker.postMessage.mock.calls[0]?.arguments, [{ type: "activate" }]);
  assert.equal(finished, false);
  activate();
  assert.equal(await startup, true);
  assert.equal(reload.mock.callCount(), 1);
});

test("a failed update check still reloads on a later controller change", async t => {
  const { registration, activate, reload } = browser(t);
  registration.update = async () => { throw new TypeError("Offline"); };
  assert.equal(await ensureLatestApp(), false);
  assert.equal(reload.mock.callCount(), 0);
  activate();
  assert.equal(reload.mock.callCount(), 1);
  activate();
  assert.equal(reload.mock.callCount(), 1);
});
