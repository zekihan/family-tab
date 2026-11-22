const STARTUP_BUDGET_MS = 5000;

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!globalThis.navigator?.serviceWorker) return Promise.resolve(undefined);
  return navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
}

/** Counts navigation time against the startup budget and returns true if it requests a reload. */
export async function ensureLatestApp(timeoutMs = STARTUP_BUDGET_MS - performance.now()): Promise<boolean> {
  if (!globalThis.navigator?.serviceWorker) return false;
  if (!navigator.onLine || timeoutMs <= 0) {
    void registerServiceWorker().catch(() => undefined);
    return false;
  }

  const serviceWorker = navigator.serviceWorker;
  const original = serviceWorker.controller;
  const listeners = new AbortController();
  const { signal } = listeners;

  return new Promise<boolean>(resolve => {
    let registration: ServiceWorkerRegistration | undefined;
    let watched: ServiceWorker | null = null;
    let requested: ServiceWorker | null = null;
    let checking = true;

    function finish(reload: boolean) {
      clearTimeout(timer);
      listeners.abort();
      if (reload) globalThis.location.reload();
      resolve(reload);
    }

    function inspect() {
      if (signal.aborted) return;
      if (serviceWorker.controller && serviceWorker.controller !== original) {
        finish(true);
        return;
      }
      const worker = registration?.waiting ?? registration?.installing ??
        (registration?.active?.state === "activating" ? registration.active : null);
      if (worker !== watched) {
        watched?.removeEventListener("statechange", inspect);
        watched = worker;
        watched?.addEventListener("statechange", inspect, { signal });
      }
      if (worker?.state === "installed" && worker !== requested) {
        requested = worker;
        worker.postMessage({ type: "activate" });
      } else if (!checking && (!worker || worker.state === "redundant")) {
        finish(false);
      }
    }

    function observe(existing: ServiceWorkerRegistration | undefined) {
      if (!existing || signal.aborted) return;
      registration = existing;
      existing.addEventListener("updatefound", inspect, { signal });
      inspect();
    }

    function checked() {
      checking = false;
      inspect();
    }

    const timer = setTimeout(() => finish(false), timeoutMs);
    serviceWorker.addEventListener("controllerchange", inspect, { signal });
    // register() can queue behind an installation already visible on this scope.
    void serviceWorker.getRegistration("/").then(existing => {
      if (!registration) observe(existing);
    }).catch(() => undefined);
    void registerServiceWorker().then(registered => {
      observe(registered);
      if (!signal.aborted) return registered?.update();
    }).then(checked, checked);
  });
}
