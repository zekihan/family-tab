export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!globalThis.navigator?.serviceWorker) return Promise.resolve(undefined);
  return navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
}

/** Returns true when a reload was requested. Call before reading cached balances. */
export async function ensureLatestApp(timeoutMs = 3000): Promise<boolean> {
  if (!globalThis.navigator?.serviceWorker) return false;
  if (!navigator.onLine) {
    void registerServiceWorker().catch(() => undefined);
    return false;
  }

  const serviceWorker = navigator.serviceWorker;
  const original = serviceWorker.controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed: (() => void) | undefined;
  let timedOut = false;
  const activated = new Promise<boolean>(resolve => {
    changed = () => {
      if (original && serviceWorker.controller !== original) resolve(true);
    };
    serviceWorker.addEventListener("controllerchange", changed);
    timer = setTimeout(() => {
      timedOut = true;
      resolve(false);
    }, timeoutMs);
  });
  const update = async () => {
    const registration = await registerServiceWorker();
    if (!registration) return false;
    // An uncontrolled page can already be running an older shell (e.g. shift-reload).
    await registration.update();
    if (timedOut) return false;
    const worker = registration.waiting ?? registration.installing;
    if (!worker) return serviceWorker.controller !== original && !!original;
    if (worker.state === "installing") {
      await new Promise<void>(resolve => {
        const onState = () => {
          if (worker.state === "installing") return;
          worker.removeEventListener("statechange", onState);
          resolve();
        };
        worker.addEventListener("statechange", onState);
        void activated.then(() => {
          worker.removeEventListener("statechange", onState);
          resolve();
        });
      });
    }
    if (timedOut || worker.state === "redundant") return false;
    worker.postMessage({ type: "activate" });
    if (original && serviceWorker.controller !== original) return true;
    return activated;
  };
  try {
    const reload = await Promise.race([activated, update().catch(() => false)]);
    if (reload) globalThis.location.reload();
    return reload;
  } finally {
    clearTimeout(timer);
    if (changed) serviceWorker.removeEventListener("controllerchange", changed);
  }
}
