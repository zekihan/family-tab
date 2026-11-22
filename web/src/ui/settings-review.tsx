import { useState } from "react";
import type { EditToken, RestorePreview, ReviewItem, SaveResult } from "../data/index.ts";
import { isValidDate } from "../ledger/index.ts";
import { SETTINGS_ID } from "../types.ts";
import type { LedgerRecord, Settings } from "../types.ts";
import { RecordSummary, SaveForm, Sheet, useLedgerUI, useSave } from "./components.tsx";
import { CashForm, PersonForm, PurchaseForm, ZoneForm } from "./forms.tsx";
import { patchBetween, recordLabels, recordName, reviewActions } from "./presentation.ts";

export function SettingsPage() {
  const { snapshot, store, notify } = useLedgerUI();
  const settings = snapshot.records.settings!;
  const [zoneEdit, setZoneEdit] = useState<{ settings: Settings; token: EditToken } | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await task(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  function download() {
    void run(async () => {
      const backup = await store.exportBackup();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `family-tab-${snapshot.ledger!.today}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Backup exported.");
    });
  }

  const { sync } = snapshot;
  const canSync = !sync.offline && !sync.needsSignIn && !sync.restoreInProgress;
  return <section className="section settings">
    <h1 tabIndex={-1}>Settings</h1>
    <article className="card">
      <div><h2>Ledger time zone</h2><p className="hint">{settings.timeZone}</p></div>
      <button className="button secondary" onClick={() => setZoneEdit({ settings, token: { generation: snapshot.generation!, version: settings.version } })}>Change time zone</button>
    </article>
    <article className="card">
      <div><h2>Export</h2><p className="hint">Download a JSON backup of your ledger and unapplied changes.</p></div>
      <button className="button secondary" disabled={busy} onClick={download}>Export backup</button>
    </article>
    <article className="card">
      <div><h2>Restore</h2><p className="hint">Replace this ledger with a Family Tab backup. Restore requires an active session and no pending changes.</p></div>
      <label className="field">Choose backup file
        <input type="file" accept=".json,application/json" disabled={!canSync || busy}
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void run(async () => setPreview(await store.previewRestore(await file.text())));
          }} />
      </label>
    </article>
    <article className="card">
      <div><h2>Sign out</h2><p className="hint">Removes your saved ledger from this device.</p></div>
      <button className="button secondary" disabled={busy || sync.restoreInProgress} onClick={() => { setError(""); setConfirmSignOut(true); }}>Sign out</button>
    </article>
    {error && !preview && !confirmSignOut && <p className="error-text" role="alert">{error}</p>}
    {zoneEdit && <Sheet title="Ledger time zone" onClose={() => setZoneEdit(null)}>
      <ZoneForm initial={zoneEdit.settings} token={zoneEdit.token}
        onSaved={() => { setZoneEdit(null); notify("Time zone saved."); }} />
    </Sheet>}
    {preview && <Sheet title="Restore backup" onClose={() => { if (!busy) { setPreview(null); setError(""); } }}>
      <SaveForm busy={busy} error={error} label="Replace ledger" blocked={!canSync || sync.pendingCount > 0}
        onSave={() => void run(async () => {
          await store.commitRestore(preview);
          setPreview(null);
          notify("Backup restored.");
        })}>
        <p>This replaces the ledger on all devices with the records in this backup.</p>
        <dl className="summary-list">
          <div><dt>Current time zone</dt><dd>{settings.timeZone}</dd></div>
          <div><dt>Backup time zone</dt><dd>{preview.backup.timeZone}</dd></div>
        </dl>
        <table className="schedule num"><thead><tr><th scope="col">Records</th><th scope="col">Current</th><th scope="col">Backup</th></tr></thead>
          <tbody>{([
            ["People", "people"], ["Purchases", "purchases"], ["Payments", "payments"], ["Shop refunds", "refunds"], ["Cash returns", "payouts"],
          ] as const).map(([label, key]) => <tr key={key}><th scope="row">{label}</th><td>{preview.currentCounts[key]}</td><td>{preview.importedCounts[key]}</td></tr>)}</tbody>
        </table>
        {preview.backup.unapplied.length > 0 && <p className="notice">The backup includes {preview.backup.unapplied.length} unapplied changes for review.</p>}
        {sync.pendingCount > 0 && <p className="notice">Resolve and sync pending changes before restoring. Preview the backup again if the ledger changes.</p>}
      </SaveForm>
    </Sheet>}
    {confirmSignOut && <Sheet title="Sign out of this device?" onClose={() => { if (!busy) { setConfirmSignOut(false); setError(""); } }}>
      <SaveForm busy={busy} error={error} label={sync.pendingCount ? "Discard changes and sign out" : "Sign out"}
        onSave={() => void run(async () => {
          const result = await store.signOut(sync.pendingCount > 0);
          if (result.status === "needsConfirmation") await store.refreshLocal();
        })}>
        <p>Your saved ledger and drafts will be removed from this device. Sign in again to download the server copy.</p>
        {sync.pendingCount > 0 && <>
          <p role="status" className="notice">{sync.pendingCount} pending {sync.pendingCount === 1 ? "change will" : "changes will"} be discarded if you sign out now.</p>
          {canSync && <button className="button secondary" type="button" disabled={busy || sync.syncing} onClick={() =>
            void run(async () => {
              await store.syncNow();
              const latest = store.getSnapshot().sync;
              if (latest.needsSignIn || latest.lastError) throw new Error(latest.lastError ?? "Sign in to finish syncing.");
            })}>Sync first</button>}
        </>}
      </SaveForm>
    </Sheet>}
  </section>;
}

function ReviewEditor({ item, onSaved }: { item: ReviewItem; onSaved: () => void }) {
  const { store, snapshot } = useLedgerUI();
  const { op } = item;
  if (op.kind === "delete") return null;
  const server = item.server;
  const original = server ?? item.local;
  const initial: Record<string, unknown> = { ...original, ...(op.kind === "update" ? op.patch : op.record) };
  const base = { id: op.recordId, version: original?.version ?? "" };
  const text = (key: string) => typeof initial[key] === "string" ? initial[key] : null;
  const integer = (key: string) => typeof initial[key] === "number" && Number.isSafeInteger(initial[key]) ? initial[key] : null;
  const date = (key: string) => {
    const value = text(key);
    return value && isValidDate(value) ? value : null;
  };
  const today = snapshot.ledger!.today;
  const personId = text("personId") ?? "";
  const purchaseId = text("purchaseId") ?? "";
  const cash = { ...base, amountMinor: integer("amountMinor") ?? 0, note: text("note") };
  const commit = (fields: Record<string, unknown>): Promise<SaveResult> => {
    const patch = server ? patchBetween({ ...server }, fields) : fields;
    return store.editAndResubmit(op.id, patch, item);
  };
  const target = { commit, onSaved };
  switch (op.recordType) {
    case "settings": return <ZoneForm {...target} initial={{
      ...base, id: SETTINGS_ID, timeZone: text("timeZone") ?? "", currency: "TRY",
    }} />;
    case "person": return <PersonForm {...target} initial={{
      ...base, name: text("name") ?? "", payday: integer("payday"), archived: initial.archived === true,
    }} />;
    case "purchase": return <PurchaseForm {...target} originalDate={server && "boughtOn" in server ? server.boughtOn : null} initial={{
      ...base, personId, item: text("item") ?? "", totalMinor: integer("totalMinor") ?? 0,
      plan: initial.plan === "installments" ? "installments" : "once", boughtOn: date("boughtOn") ?? today,
      dueDate: date("dueDate"), count: integer("count"), firstDue: date("firstDue"), dueDay: integer("dueDay"), note: text("note"),
    }} />;
    case "payment": return <CashForm {...target} type="payment" personId={personId}
      originalDate={server && "paidOn" in server ? server.paidOn : null}
      initial={{ ...cash, personId, paidOn: date("paidOn") ?? today }} />;
    case "payout": return <CashForm {...target} type="payout" personId={personId}
      originalDate={server && "paidOutOn" in server ? server.paidOutOn : null}
      initial={{ ...cash, personId, paidOutOn: date("paidOutOn") ?? today }} />;
    case "refund": return <CashForm {...target} type="refund" purchaseId={purchaseId}
      originalDate={server && "refundedOn" in server ? server.refundedOn : null}
      initial={{ ...cash, purchaseId, refundedOn: date("refundedOn") ?? today }} />;
  }
}

function ReviewCard({ item }: { item: ReviewItem }) {
  const { snapshot, store, notify } = useLedgerUI();
  const [editor, setEditor] = useState<ReviewItem | null>(null);
  const [confirmer, setConfirmer] = useState<ReviewItem | null>(null);
  const save = useSave(() => notify("Review change resolved."));
  const { op } = item;
  const actions = reviewActions(item);
  const local = item.local ?? (op.kind === "delete" ? op.preImage : op.kind === "create" ? op.record as LedgerRecord : null);
  const busy = save.busy || snapshot.sync.restoreInProgress;
  const waiting = item.waitingForRestoredLedger;
  return <article className="card review-card">
    <div><h2>{op.kind === "create" ? "Add" : op.kind === "update" ? "Edit" : "Delete"} {recordLabels[op.recordType]}</h2>
      <p className="expected">{waiting ? "Waiting for the restored ledger to finish syncing." : item.reason}</p></div>
    <div className="review-versions">
      <section><h3>Your change</h3>{op.kind === "delete" && <p className="hint">Marked for deletion</p>}
        {!local && op.kind === "update" ? <details>
          <summary>Show saved changes</summary>
          <pre className="review-payload">{JSON.stringify(op.patch, null, 2)}</pre>
        </details> : <RecordSummary record={local} records={snapshot.records} />}</section>
      {!waiting && <section><h3>Server version</h3><RecordSummary record={item.server} records={snapshot.records} /></section>}
    </div>
    {item.blockingIds.length > 0 && <section>
      <h3>Blocking records</h3>
      <ul className="blocking-list">{item.blockingIds.map(id => <li key={id}>
        <RecordSummary record={item.blocking.find(row => row.id === id) ?? null} records={snapshot.records} />
        {!item.blocking.some(row => row.id === id) && <p className="hint">{id}</p>}
      </li>)}</ul>
    </section>}
    {item.waiting.length > 0 && <section><h3>Waiting behind this change</h3>
      <ul className="waiting-list">{item.waiting.map(waiting => <li key={waiting.id}>
        {waiting.kind === "create" ? "Add" : waiting.kind === "update" ? "Edit" : "Delete"} {recordLabels[waiting.recordType]} · {
          recordName(waiting.kind === "create" ? waiting.record as Parameters<typeof recordName>[0] :
            waiting.kind === "delete" ? waiting.preImage : null) ?? waiting.recordId}
      </li>)}</ul>
    </section>}
    {item.waitingOnEarlier && <p className="hint">Waiting for earlier changes to be resolved.</p>}
    {!waiting && <div className="actions">
      {actions.keepServer && <button className="button secondary" disabled={busy} onClick={() => void save.submit(() => store.keepServer(op.id, item))}>Keep server</button>}
      {!item.waitingOnEarlier && <>
        {actions.keep && <button className="button secondary" disabled={busy} onClick={() => void save.submit(() => store.keepLocal(op.id, item))}>{item.restore ? "Apply to restored ledger" : "Keep mine"}</button>}
        {actions.edit && <button className="button secondary" disabled={busy} onClick={() => setEditor(item)}>Edit and resubmit</button>}
        {!actions.edit && !actions.keep && <button className="button secondary" disabled={busy} onClick={() => void save.submit(() => store.keepLocal(op.id, item))}>Retry deletion</button>}
        {actions.confirmPayout && item.local && <button className="button secondary" disabled={busy} onClick={() => setConfirmer(item)}>Confirm cash already returned</button>}
      </>}
      {!actions.keepServer && <button className="button quiet" disabled={busy} onClick={() => void save.submit(() => store.discard(op.id))}>Discard</button>}
    </div>}
    {save.error && !confirmer && <p className="error-text" role="alert">{save.error}</p>}
    {editor && !waiting && !item.waitingOnEarlier && <Sheet title={`Resubmit ${recordLabels[op.recordType]}`} onClose={() => setEditor(null)}>
      <ReviewEditor item={editor} onSaved={() => { setEditor(null); notify("Change resubmitted."); }} />
    </Sheet>}
    {confirmer && !waiting && !item.waitingOnEarlier && <Sheet title="Confirm cash already returned" onClose={() => setConfirmer(null)}>
      <SaveForm {...save} label="Confirm cash already returned" onSave={() => void save.submit(() => store.confirmAlreadyReturned(op.id, confirmer))}>
        <p>Confirm only if you have already returned this cash. The payout may create a cash shortfall.</p>
        <RecordSummary record={confirmer.local} records={snapshot.records} />
      </SaveForm>
    </Sheet>}
  </article>;
}

export function Review() {
  const { snapshot } = useLedgerUI();
  return <section className="section">
    <h1 tabIndex={-1}>Review</h1>
    {snapshot.reviewItems.length
      ? <div className="card-stack">{snapshot.reviewItems.map(item => <ReviewCard key={item.op.id} item={item} />)}</div>
      : <p className="empty">No changes need review.</p>}
  </section>;
}
