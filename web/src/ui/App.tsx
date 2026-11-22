import { Activity, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createStore, loginURL } from "../data/index.ts";
import { formatTRY } from "../ledger/index.ts";
import { LedgerContext, SaveForm, Sheet, useLedgerUI, useSave } from "./components.tsx";
import { CashForm, PersonForm, PurchaseForm, ZoneForm } from "./forms.tsx";
import { Archive, Home, PersonPage, SyncBanner, UndoToasts } from "./ledger-screens.tsx";
import type { EntryAction } from "./ledger-screens.tsx";
import { Review, ReviewCard, SettingsPage } from "./settings-review.tsx";
import type { EditToken } from "../data/index.ts";

const store = createStore();

function subscribeRoute(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

function routePath() {
  return window.location.hash.slice(1) || "/";
}

function routePerson(path: string) {
  if (!path.startsWith("/person/")) return null;
  try { return decodeURIComponent(path.slice("/person/".length)); }
  catch { return null; }
}

const entryTitles: Record<EntryAction["kind"], string> = {
  purchase: "Add purchase", payment: "Record a payment", refund: "Record shop refund",
  payout: "Record cash returned", person: "Edit person", archive: "Archive person",
};

function ArchiveForm({ action, token, onSaved }: { action: Extract<EntryAction, { kind: "archive" }>; token: EditToken; onSaved: () => void }) {
  const { store, snapshot } = useLedgerUI();
  const [opened, setOpened] = useState(token);
  const [archived, setArchived] = useState(!action.record.archived);
  const balance = snapshot.ledger!.balances[action.record.id];
  const save = useSave(() => {
    if (archived) window.location.hash = "/archive";
    onSaved();
  });
  return <SaveForm {...save} label={archived ? "Archive person" : "Unarchive person"}
    onSave={() => void save.submit(() => store.updateRecord("person", action.record.id, opened, { archived }))}
    onReapply={() => {
      if (!save.stale?.current || !("archived" in save.stale.current)) return;
      setOpened({ generation: save.stale.generation, version: save.stale.current.version });
      setArchived(!save.stale.current.archived);
      save.setStale(null);
    }}>
    {archived ? <>
      <p>{action.record.name} will move to the archive with their records. You can still record payments, shop refunds and cash returned.</p>
      <p className="notice">Outstanding balance <strong className="num">{formatTRY(balance?.leftToPay ?? 0)}</strong> · Included in Home totals.</p>
    </> : <p>{action.record.name} will return to the People list and can receive new purchases.</p>}
  </SaveForm>;
}

function EntrySheet({ action, token, onClose }: { action: EntryAction; token?: EditToken; onClose: () => void }) {
  const { notify } = useLedgerUI();
  const title = action.kind === "archive" && action.record.archived ? "Unarchive person"
    : action.record && action.kind !== "person" && action.kind !== "archive"
      ? { purchase: "Edit purchase", payment: "Edit payment", refund: "Edit shop refund", payout: "Edit cash returned" }[action.kind]
      : entryTitles[action.kind];
  const onSaved = () => { onClose(); notify(action.kind === "archive" ? "Person updated." : "Saved."); };
  const target = { onSaved, token };
  return <Sheet title={title} onClose={onClose}>
    {action.kind === "purchase" && <PurchaseForm {...target} initial={action.record} personId={action.personId} />}
    {action.kind === "payment" && <CashForm {...target} type="payment" initial={action.record} personId={action.personId} />}
    {action.kind === "refund" && <CashForm {...target} type="refund" initial={action.record} purchaseId={action.purchaseId} />}
    {action.kind === "payout" && <CashForm {...target} type="payout" initial={action.record} personId={action.personId} />}
    {action.kind === "person" && <PersonForm {...target} initial={action.record} />}
    {action.kind === "archive" && token && <ArchiveForm action={action} token={token} onSaved={onSaved} />}
  </Sheet>;
}

function Workspace() {
  const { snapshot } = useLedgerUI();
  const path = useSyncExternalStore(subscribeRoute, routePath);
  const previousPath = useRef(path);
  const main = useRef<HTMLElement>(null);
  const [entry, setEntry] = useState<{ path: string; action: EntryAction; token?: EditToken } | null>(null);
  useEffect(() => {
    if (path === previousPath.current) return;
    previousPath.current = path;
    setEntry(null);
    window.scrollTo(0, 0);
    main.current?.scrollTo(0, 0);
    main.current?.querySelector("h1")?.focus();
  }, [path]);

  function open(action: EntryAction) {
    const token = action.record && snapshot.generation ? { generation: snapshot.generation, version: action.record.version } : undefined;
    setEntry({ action, token, path });
  }

  const personId = routePerson(path);
  const personArchived = !!personId && snapshot.records.people.find(person => person.id === personId)?.archived;
  const home = path === "/";
  return <div className={home ? "home-layout" : undefined}>
    <header className="app-header">
      <div className="shell header-content">
        <a className="brand" href="#/"><img src="/icon.svg" alt="" width="34" height="34" /> Family Tab</a>
        {home ? <details className="menu">
          <summary className="button secondary">Menu <span aria-hidden="true">⌄</span></summary>
          <nav aria-label="Main menu">
            <a href="#/settings">Settings</a>
          </nav>
        </details> : <a className="button quiet" href={personArchived ? "#/archive" : "#/"}>‹ {personArchived ? "Archive" : "Home"}</a>}
      </div>
    </header>
    <main className="shell workspace" ref={main}>
      <SyncBanner />
      {home ? <Home />
        : path === "/archive" ? <Archive />
        : path === "/settings" ? <SettingsPage />
        : path === "/review" ? <Review />
        : personId ? <PersonPage key={personId} id={personId} open={open} />
        : <section className="section"><h1 tabIndex={-1}>Page unavailable</h1><a className="button secondary" href="#/">Back to Home</a></section>}
    </main>
    {home && <div className="home-actions">
      <div className="shell">
        <button className="button primary" onClick={() => open({ kind: "purchase" })}>+ Add purchase</button>
      </div>
    </div>}
    {entry?.path === path && <EntrySheet action={entry.action} token={entry.token} onClose={() => setEntry(null)} />}
    <UndoToasts />
  </div>;
}

function Gate({ title, children }: { title: string; children?: React.ReactNode }) {
  return <main className="gate">
    <div className="card gate-card">
      <img src="/icon.svg" alt="" width="56" height="56" />
      <h1>{title}</h1>
      {children}
    </div>
  </main>;
}

function Session() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [lastReady, setLastReady] = useState(snapshot);
  const [notice, setNotice] = useState("");
  const [startError, setStartError] = useState("");
  useEffect(() => {
    // The store registers the service worker and checks for an update before opening IndexedDB.
    void store.start().catch(error => setStartError(error instanceof Error ? error.message : String(error)));
    return () => store.stop();
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (snapshot.ready && snapshot !== lastReady) setLastReady(snapshot);
  // A visibility change masks the store until it checks for cross-tab sign-out.
  // Keep drafts suspended during that check and clear them when the session is gone.
  const cached = snapshot.ready ? snapshot : lastReady;
  const hasWorkspace = !!(cached.buyer && cached.ledger && !cached.sync.signOutPending && !startError);
  const { sync } = snapshot;
  const setupReview = snapshot.reviewItems.filter(item => item.op.recordType === "settings");
  return <LedgerContext.Provider value={{ store, snapshot, notify: setNotice }}>
    {startError ? <Gate title="Family Tab"><p role="alert">{startError}</p>
      <button className="button primary" onClick={() => window.location.reload()}>Try again</button></Gate>
      : !snapshot.ready || (!snapshot.buyer && sync.syncing && !sync.signOutPending)
        ? <Gate title="Family Tab"><p role="status">Opening ledger…</p></Gate>
        : sync.signOutPending ? <Gate title="Family Tab">
          <p role="status">{sync.offline ? "Connect to finish signing out." : sync.lastError ?? "Finishing sign-out…"}</p>
          {!sync.offline && sync.lastError && <button className="button secondary" onClick={() => void store.syncNow()}>Sync now</button>}
        </Gate>
          : !snapshot.buyer ? <Gate title="Family Tab">
            <a className="button primary" href={loginURL}>Sign in with SSO</a>
            {sync.offline && <p className="hint">Connect to sign in.</p>}
          </Gate>
            : !snapshot.records.settings ? <Gate title={snapshot.generation ? "Set up your ledger" : "Family Tab"}>
              <SyncBanner showReviewLink={false} />
              {!snapshot.generation ? <p role="status">Downloading your ledger…</p>
                : setupReview.length > 0 ? setupReview.map(item => <ReviewCard key={item.op.id} item={item} />)
                : <ZoneForm onSaved={() => { window.location.hash = "/"; }} />}
            </Gate>
              : null}
    {hasWorkspace && <Activity mode={snapshot.ready ? "visible" : "hidden"} key={cached.sessionEpoch}>
      <LedgerContext.Provider value={{ store, snapshot: cached, notify: setNotice }}>
        <Workspace />
      </LedgerContext.Provider>
    </Activity>}
    <div className="announcement" role="status" aria-live="polite">{snapshot.buyer && notice}</div>
  </LedgerContext.Provider>;
}

export default function App() {
  return <Session />;
}
