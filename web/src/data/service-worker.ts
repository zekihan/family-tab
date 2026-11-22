export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!globalThis.navigator?.serviceWorker) return Promise.resolve(undefined);
  return navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
}

/** Returns true when a reload was requested. The legacy timeout no longer limits the startup check. */
export async function ensureLatestApp(timeoutMs = 3000): Promise<boolean> {
  void timeoutMs;
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

  const check = async (): Promise<boolean> => {
    let registration: ServiceWorkerRegistration | undefined;
    try {
      registration = await registerServiceWorker();
      if (reloading || !registration) return reloading;
      await registration.update();
    } catch (error) {
      watchActivation = true;
      if (!navigator.onLine || error instanceof TypeError ||
          (error instanceof DOMException && error.name === "NetworkError")) return false;
      throw error;
    }

    changed();
    if (reloading) return true;
    // Activation can already be in progress when another tab requested it.
    const worker = registration.installing ?? registration.waiting ??
      (registration.active?.state === "activating" ? registration.active : null);
    if (!worker) return false;
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
  try {
    return await Promise.race([activated, check()]);
  } finally {
    if (!watchActivation) serviceWorker.removeEventListener("controllerchange", changed);
  }
}
