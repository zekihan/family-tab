import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { ensureLatestApp } from "../../src/data/service-worker.ts";
import { deferred } from "./helpers.ts";

function browser(t: TestContext) {
  const original = {};
  const registration = Object.assign(new EventTarget(), {
    update: async () => {}, installing: null as EventTarget | null, waiting: null as EventTarget | null,
  });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: original, register: async () => registration, getRegistration: async () => registration,
  });
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
  return { serviceWorker, registration, activate, reload };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

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
  const startup = ensureLatestApp(5000).then(result => {
    finished = true;
    return result;
  });
  await entered.promise;
  t.mock.timers.tick(3500);
  await flush();
  assert.equal(finished, false);
  const worker = Object.assign(new EventTarget(), { state: "installing", postMessage: t.mock.fn() });
  registration.installing = worker;
  checked.resolve();
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(finished, false);
  assert.equal(worker.postMessage.mock.callCount(), 0);
  worker.state = "installed";
  worker.dispatchEvent(new Event("statechange"));
  await flush();
  assert.deepEqual(worker.postMessage.mock.calls[0]?.arguments, [{ type: "activate" }]);
  assert.equal(finished, false);
  activate();
  assert.equal(await startup, true);
  assert.equal(reload.mock.callCount(), 1);
});

for (const stalled of ["register", "update"] as const) {
  test(`startup times out a stalled ${stalled} without reloading on a later controller change`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { serviceWorker, registration, activate, reload } = browser(t);
    const entered = deferred<void>();
    const stall = () => {
      entered.resolve();
      return new Promise<never>(() => {});
    };
    if (stalled === "register") serviceWorker.register = stall;
    else registration.update = stall;
    const finished = t.mock.fn();
    const startup = ensureLatestApp(50).then(finished);
    await entered.promise;
    t.mock.timers.tick(49);
    await flush();
    assert.equal(finished.mock.callCount(), 0);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(finished.mock.calls.map(call => call.arguments), [[false]]);
    await startup;
    activate();
    activate();
    assert.equal(reload.mock.callCount(), 0);
  });
}

test("startup follows a visible installation while the update check is pending", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registration, activate } = browser(t);
  const entered = deferred<void>();
  registration.update = () => {
    entered.resolve();
    return new Promise<never>(() => {});
  };
  const finished = t.mock.fn();
  const startup = ensureLatestApp(50).then(finished);
  await entered.promise;
  const worker = Object.assign(new EventTarget(), { state: "installing", postMessage: t.mock.fn() });
  registration.installing = worker;
  registration.dispatchEvent(new Event("updatefound"));
  t.mock.timers.tick(25);
  await flush();
  assert.equal(finished.mock.callCount(), 0);
  worker.state = "installed";
  registration.installing = null;
  registration.waiting = worker;
  worker.dispatchEvent(new Event("statechange"));
  await flush();
  assert.deepEqual(worker.postMessage.mock.calls.map(call => call.arguments), [[{ type: "activate" }]]);
  activate();
  await startup;
  assert.deepEqual(finished.mock.calls.map(call => call.arguments), [[true]]);
});

test("a stalled installation opens the ledger and leaves the finished worker waiting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registration, activate, reload } = browser(t);
  const worker = Object.assign(new EventTarget(), { state: "installing", postMessage: t.mock.fn() });
  registration.installing = worker;
  const finished = t.mock.fn();
  const startup = ensureLatestApp(50).then(finished);
  await flush();
  assert.equal(finished.mock.callCount(), 0);
  t.mock.timers.tick(50);
  await flush();
  assert.deepEqual(finished.mock.calls.map(call => call.arguments), [[false]]);
  await startup;

  worker.state = "installed";
  registration.installing = null;
  registration.waiting = worker;
  worker.dispatchEvent(new Event("statechange"));
  await flush();
  assert.equal(worker.postMessage.mock.callCount(), 0);
  assert.equal(reload.mock.callCount(), 0);

  const nextStartup = ensureLatestApp(50);
  await flush();
  assert.deepEqual(worker.postMessage.mock.calls.map(call => call.arguments), [[{ type: "activate" }]]);
  activate();
  assert.equal(await nextStartup, true);
  assert.equal(reload.mock.callCount(), 1);
});

test("an update discovered after the startup deadline stays waiting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registration, reload } = browser(t);
  const checked = deferred<void>();
  registration.update = () => checked.promise;
  const startup = ensureLatestApp(50);
  await flush();
  t.mock.timers.tick(50);
  assert.equal(await startup, false);

  const worker = Object.assign(new EventTarget(), { state: "installed", postMessage: t.mock.fn() });
  registration.waiting = worker;
  registration.dispatchEvent(new Event("updatefound"));
  checked.resolve();
  await flush();
  assert.equal(worker.postMessage.mock.callCount(), 0);
  assert.equal(reload.mock.callCount(), 0);
});

test("activation requested during startup cannot reload after the deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registration, activate, reload } = browser(t);
  const worker = Object.assign(new EventTarget(), { state: "installed", postMessage: t.mock.fn() });
  registration.waiting = worker;
  const finished = t.mock.fn();
  const startup = ensureLatestApp(50).then(finished);
  await flush();
  assert.equal(worker.postMessage.mock.callCount(), 1);
  t.mock.timers.tick(50);
  await flush();
  assert.deepEqual(finished.mock.calls.map(call => call.arguments), [[false]]);
  await startup;
  activate();
  assert.equal(reload.mock.callCount(), 0);
});

test("a failed update check cannot reload after the ledger opens", async t => {
  const { registration, activate, reload } = browser(t);
  registration.update = async () => { throw new TypeError("Offline"); };
  assert.equal(await ensureLatestApp(), false);
  assert.equal(reload.mock.callCount(), 0);
  activate();
  assert.equal(reload.mock.callCount(), 0);
});

test("startup can reload for a controller change before a failed check settles", async t => {
  const { registration, activate, reload } = browser(t);
  registration.update = async () => {
    activate();
    throw new TypeError("Offline");
  };
  assert.equal(await ensureLatestApp(), true);
  assert.equal(reload.mock.callCount(), 1);
});
