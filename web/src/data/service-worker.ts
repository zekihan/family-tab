export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!globalThis.navigator?.serviceWorker) return Promise.resolve(undefined);
  return navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
}

/** Returns true when a reload was requested. The deadline bounds network discovery only. */
export async function ensureLatestApp(timeoutMs = 5000): Promise<boolean> {
  if (!globalThis.navigator?.serviceWorker) return false;

  const serviceWorker = navigator.serviceWorker;
  const original = serviceWorker.controller;
  let resolveActivation!: (value: true) => void;
  const activated = new Promise<true>(resolve => { resolveActivation = resolve; });
  let reloading = false;
  let watchActivation = false;
  const changed = () => {
    if (reloading || !serviceWorker.controller || serviceWorker.controller === original) return;
    reloading = true;
    serviceWorker.removeEventListener("controllerchange", changed);
    globalThis.location.reload();
    resolveActivation(true);
  };
  serviceWorker.addEventListener("controllerchange", changed);
  if (!navigator.onLine) {
    void registerServiceWorker().catch(() => undefined);
    return false;
  }

  let registration: ServiceWorkerRegistration | undefined;
  const waitForUpdate = () => {
    changed();
    if (reloading) return activated;
    // Activation can already be in progress when another tab requested it.
    const worker = registration?.installing ?? registration?.waiting ??
      (registration?.active?.state === "activating" ? registration.active : null);
    if (!worker) return null;
    return activateWorker(worker);
  };
  const activateWorker = async (worker: ServiceWorker): Promise<true> => {
    if (worker.state === "installing") {
      let onState!: () => void;
      const installed = new Promise<void>(resolve => {
        onState = () => { if (worker.state !== "installing") resolve(); };
        worker.addEventListener("statechange", onState);
      });
      try {
        await Promise.race([installed, activated]);
      } finally {
        worker.removeEventListener("statechange", onState);
      }
    }
    if (reloading) return true;
    if (worker.state === "redundant") {
      watchActivation = true;
      throw new Error("The Family Tab update did not finish installing.");
    }
    if (worker.state === "installed") worker.postMessage({ type: "activate" });
    return activated;
  };

  // A pending register() may be queued behind another job for the same scope.
  void serviceWorker.getRegistration("/").then(existing => { registration ??= existing; }).catch(() => undefined);
  const checked = registerServiceWorker().then(async registered => {
    registration = registered;
    if (!reloading) await registration?.update();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); });
  const check = async (): Promise<boolean> => {
    let timedOut = false;
    try {
      timedOut = (await Promise.race([checked, deadline])) === true;
    } catch (error) {
      watchActivation = true;
      if (navigator.onLine && !(error instanceof TypeError) &&
          !(error instanceof DOMException && error.name === "NetworkError")) throw error;
    }

    if (timedOut) watchActivation = true;
    const update = waitForUpdate();
    if (update) return update;
    // A slow check can still discover an update after the ledger has opened.
    if (timedOut) void checked.then(waitForUpdate).catch(() => undefined);
    return false;
  };
  try {
    return await Promise.race([activated, check()]);
  } finally {
    clearTimeout(timer);
    if (!watchActivation) serviceWorker.removeEventListener("controllerchange", changed);
  }
}
