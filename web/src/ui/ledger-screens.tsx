import { useState } from "react";
import { loginURL } from "../data/index.ts";
import type { StoreSnapshot } from "../data/index.ts";
import type { PurchaseView } from "../ledger/index.ts";
import { formatTRY } from "../ledger/index.ts";
import type { LedgerRecord, Operation, Payment, Payout, Person, Purchase, RecordType, Refund } from "../types.ts";
import { Figure, personURL, RecordSummary, SaveForm, Sheet, useLedgerUI, useSave } from "./components.tsx";
import { displayDate, recordLabels, recordName, statusText } from "./presentation.ts";

export function SyncBanner({ showReviewLink = true }: { showReviewLink?: boolean }) {
  const { snapshot, store } = useLedgerUI();
  const sync = snapshot.sync;
  if (!(sync.pendingCount || sync.offline || sync.needsSignIn || sync.needsReview || sync.restoreInProgress || sync.lastError)) return null;
  return <aside className="sync-banner" aria-label="Sync status">
    <div aria-live="polite">
      {sync.restoreInProgress && <strong>Restore in progress</strong>}
      {sync.needsSignIn && <p>Sign in to resume sync. Your saved ledger is available on this device.</p>}
      {sync.offline && <p>Offline · Changes are saved on this device.</p>}
      {sync.pendingCount > 0 && <p>{sync.pendingCount} {sync.pendingCount === 1 ? "change" : "changes"} pending</p>}
      {sync.needsReview && <p>Some changes need review.</p>}
      {sync.lastError && !sync.needsSignIn && !sync.offline && <p>{sync.lastError}</p>}
    </div>
    <div className="actions">
      {sync.needsSignIn && !sync.offline && <a className="button secondary small" href={loginURL}>Sign in with SSO</a>}
      {sync.needsReview && showReviewLink && <a className="button secondary small" href="#/review">Review changes</a>}
      <button className="button secondary small" disabled={sync.syncing || sync.offline || sync.needsSignIn || sync.restoreInProgress}
        onClick={() => void store.syncNow()}>{sync.syncing ? "Syncing…" : "Sync now"}</button>
    </div>
  </aside>;
}

function PersonRow({ person }: { person: Person }) {
  const { snapshot } = useLedgerUI();
  const ledger = snapshot.ledger!;
  const balance = ledger.balances[person.id];
  const chip = ledger.chips[person.id];
  const tone = chip.kind === "credit" || chip.kind === "allPaid" ? "paid" : chip.kind === "whenTheyCan" ? "" : "expected";
  return <li><a className="person-row" href={personURL(person.id)}>
    <span className="avatar" aria-hidden="true">{Array.from(person.name.trim())[0]?.toLocaleUpperCase()}</span>
    <strong className="row-name">{person.name}</strong>
    <span className={`status-chip ${tone}`}>{statusText(chip)}{chip.behindPlan && " · Behind plan"}</span>
    <span className="row-balance num">{formatTRY(balance.leftToPay)} <span aria-hidden="true">›</span></span>
  </a></li>;
}

export function Home() {
  const { snapshot } = useLedgerUI();
  const { ledger, records } = snapshot;
  const { home, homeOrder, comingUp, today } = ledger!;
  const people = new Map(records.people.map(person => [person.id, person]));
  const purchases = new Map(records.purchases.map(purchase => [purchase.id, purchase]));
  return <>
    <section className="hero">
      <p className="hero-date"><time dateTime={today}>{displayDate(today)}</time></p>
      <h1 tabIndex={-1}>Your family owes you <span className="num hero-amount">{formatTRY(home.leftToPay)}</span></h1>
      {home.credit > 0 && <p className="hero-credit">Total credit held <strong className="num">{formatTRY(home.credit)}</strong></p>}
      <dl className="home-figures">
        <Figure label="Due by today" value={home.dueByToday} />
        <Figure label="Due in the next month" value={home.dueNextMonth} />
      </dl>
    </section>
    <div className="home-grid">
      <section className="section">
        <h2>People</h2>
        {homeOrder.length ? <ul className="list-card">{homeOrder.map(id => <PersonRow key={id} person={people.get(id)!} />)}</ul>
          : <p className="empty">Add a purchase to start a tab for someone.</p>}
        <a href="#/archive" className="archive-link"><span>Archive</span><strong className="num">{formatTRY(home.archivedLeftToPay)} <span aria-hidden="true">›</span></strong></a>
      </section>
      <section className="section">
        <h2>Coming up</h2>
        {comingUp.length ? <ul className="list-card upcoming-list">{comingUp.map(entry =>
          <li key={`${entry.purchaseId}:${entry.sequence}`}><a className="upcoming-row" href={personURL(entry.personId)}>
            <span><strong>{purchases.get(entry.purchaseId)?.item}</strong>
              <span className="hint">{people.get(entry.personId)?.name}{entry.archived && " · Archived"} · <time dateTime={entry.dueOn}>{displayDate(entry.dueOn)}</time></span>
            </span>
            <strong className="num expected">{formatTRY(entry.remainingMinor)}</strong>
          </a></li>)}</ul> : <p className="empty">Nothing is due in the next month.</p>}
      </section>
    </div>
  </>;
}

export function Archive() {
  const { snapshot } = useLedgerUI();
  const people = snapshot.records.people.filter(person => person.archived).sort((a, b) => a.name.localeCompare(b.name));
  return <section className="section">
    <h1 tabIndex={-1}>Archive</h1>
    <dl className="figures"><Figure label="Archived balance" value={snapshot.ledger!.home.archivedLeftToPay} /></dl>
    {people.length ? <ul className="list-card">{people.map(person => <PersonRow key={person.id} person={person} />)}</ul>
      : <p className="empty">There are no archived people.</p>}
  </section>;
}

export type EntryAction =
  | { kind: "purchase"; personId?: string; record?: Purchase }
  | { kind: "payment"; personId: string; record?: Payment }
  | { kind: "refund"; purchaseId: string; record?: Refund }
  | { kind: "payout"; personId: string; record?: Payout }
  | { kind: "person"; record: Person }
  | { kind: "archive"; record: Person };

type DeleteType = Exclude<RecordType, "settings">;

function EntryButtons({ label, onEdit, onDelete }: { label: string; onEdit: () => void; onDelete?: () => void }) {
  const { snapshot } = useLedgerUI();
  return <div className="actions">
    <button className="button secondary small" aria-label={`Edit ${label}`} onClick={onEdit}>Edit</button>
    {onDelete && <button className="button quiet small" aria-label={`Delete ${label}`} disabled={snapshot.sync.restoreInProgress} onClick={onDelete}>Delete</button>}
  </div>;
}

function Schedule({ view }: { view: PurchaseView }) {
  return <details className="dates"><summary>Show dates</summary>
    <table className="schedule num">
      <thead><tr><th scope="col">Due</th><th scope="col">Original</th><th scope="col">Adjusted</th><th scope="col">Left</th></tr></thead>
      <tbody>{view.adjusted.map((row, i) => <tr key={row.sequence}>
        <th scope="row">{row.dueOn ? displayDate(row.dueOn) : "No fixed date"}</th>
        <td>{formatTRY(view.base[i].baseMinor)}</td><td>{formatTRY(row.adjustedMinor)}</td>
        <td>{formatTRY(row.adjustedMinor - view.paid[i])}</td>
      </tr>)}</tbody>
    </table>
  </details>;
}

function PurchaseCard({ purchase, open, remove }: {
  purchase: Purchase; open: (action: EntryAction) => void; remove: (type: DeleteType, record: LedgerRecord) => void;
}) {
  const { snapshot } = useLedgerUI();
  const view = snapshot.ledger!.purchases[purchase.id];
  const refunds = snapshot.records.refunds.filter(row => row.purchaseId === purchase.id)
    .sort((a, b) => b.refundedOn.localeCompare(a.refundedOn) || b.id.localeCompare(a.id));
  const nextAmount = view.adjusted.reduce((sum, row, i) =>
    row.dueOn && row.dueOn === view.earliestUnpaidDue ? sum + row.adjustedMinor - view.paid[i] : sum, 0);
  const net = purchase.totalMinor - view.refundedMinor;
  const refundedCount = view.adjusted.length - view.payableCount;
  return <article className="card purchase-card">
    <div className="card-title"><div><h3>{purchase.item}</h3><p className="hint">{displayDate(purchase.boughtOn)} · {purchase.plan === "once" ? "All at once" : `${purchase.count} installments`}</p></div>
      <div className="align-end"><strong className="num">{formatTRY(purchase.totalMinor)}</strong><p className="hint">Original total</p></div>
    </div>
    {purchase.note && <p className="entry-note">{purchase.note}</p>}
    <div className="progress-block">
      <div className="card-title"><span className="hint">{net === 0 ? "Fully refunded" : purchase.plan === "installments"
        ? `${view.paidCount} of ${view.payableCount} installments paid` : `${formatTRY(net - view.leftMinor)} paid`}</span>
        <strong className={`num ${view.leftMinor === 0 ? "paid" : ""}`}>{formatTRY(view.leftMinor)} left</strong></div>
      {purchase.plan === "installments" && net > 0 && refundedCount > 0 && <p className="hint">{refundedCount} refunded</p>}
      {net > 0 && <progress max={net} value={net - view.leftMinor} aria-label={`Repayment progress for ${purchase.item}`} />}
      {view.earliestUnpaidDue && <p className="hint expected">Due {displayDate(view.earliestUnpaidDue)} · {formatTRY(nextAmount)}</p>}
    </div>
    <Schedule view={view} />
    {refunds.length > 0 && <div className="refunds">
      <h4 className="num">Shop refunds · {formatTRY(view.refundedMinor)}</h4>
      <ul>{refunds.map(row => <li key={row.id} className="history-row">
        <div><strong className="num">{formatTRY(row.amountMinor)}</strong><p className="hint">{displayDate(row.refundedOn)}</p>
          {row.note && <p className="entry-note">{row.note}</p>}</div>
        <EntryButtons label={`shop refund for ${purchase.item}`} onEdit={() => open({ kind: "refund", purchaseId: purchase.id, record: row })}
          onDelete={() => remove("refund", row)} />
      </li>)}</ul>
    </div>}
    <div className="actions">
      <EntryButtons label={purchase.item} onEdit={() => open({ kind: "purchase", record: purchase })}
        onDelete={refunds.length === 0 ? () => remove("purchase", purchase) : undefined} />
      {net > 0 && <button className="button secondary small" onClick={() => open({ kind: "refund", purchaseId: purchase.id })}>Record shop refund</button>}
    </div>
    {refunds.length > 0 && <p className="hint">Remove linked shop refunds before deleting this purchase.</p>}
  </article>;
}

export function PersonPage({ id, open }: { id: string; open: (action: EntryAction) => void }) {
  const { snapshot, store } = useLedgerUI();
  const { records, ledger, generation, sync } = snapshot;
  const person = records.people.find(row => row.id === id);
  const balance = person ? ledger!.balances[id] : null;
  const [deletion, setDeletion] = useState<{ type: DeleteType; record: LedgerRecord; generation: string } | null>(null);
  const deleteAction = useSave(() => setDeletion(null));

  function remove(type: DeleteType, record: LedgerRecord) {
    if (sync.restoreInProgress || !generation || deleteAction.busy) return;
    setDeletion({ type, record, generation });
    void deleteAction.submit(() => store.deleteRecord(type, record.id, { generation, version: record.version }));
  }

  const purchases = records.purchases.filter(row => row.personId === id)
    .sort((a, b) => b.boughtOn.localeCompare(a.boughtOn) || b.id.localeCompare(a.id));
  const history = [
    ...records.payments.filter(row => row.personId === id).map(row => ({ date: row.paidOn, kind: "payment" as const, row })),
    ...records.payouts.filter(row => row.personId === id).map(row => ({ date: row.paidOutOn, kind: "payout" as const, row })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.row.id.localeCompare(a.row.id));

  const stale = deleteAction.stale;
  return <>
    {deletion && (deleteAction.error || stale) && <Sheet title={`Delete ${recordLabels[deletion.type]}`} onClose={() => setDeletion(null)}>
      <SaveForm busy={deleteAction.busy} error={deleteAction.error} label="Delete current version" blocked={!stale?.current}
        onSave={() => {
          if (!stale?.current) return;
          const { id, version } = stale.current;
          void deleteAction.submit(() => store.deleteRecord(deletion.type, id, { generation: stale.generation, version }));
        }}>
        {stale && <p>{stale.current ? "This record changed. Review its current version before deleting." : "This record was already removed."}</p>}
        {stale?.current && <RecordSummary record={stale.current} records={records} />}
      </SaveForm>
    </Sheet>}
    {person && balance ? <>
      <div className="person-heading"><h1 tabIndex={-1}>{person.name}</h1>
        {person.archived && <span className="status-chip">Archived</span>}
        {balance.behindPlan && <span className="status-chip expected">Behind plan</span>}
      </div>
      <dl className="figures">
        <Figure label="Due by today" value={balance.dueByToday} tone={balance.dueByToday > 0 ? "expected" : undefined} />
        <Figure label="Left to pay" value={balance.leftToPay} detail={balance.cashShortfall > 0 ? <span className="num">Includes {formatTRY(balance.cashShortfall)} cash shortfall</span> : undefined} />
        <Figure label="Payments received" value={balance.paymentsReceived} />
        <Figure label="Cash returned" value={balance.cashReturned} />
        {balance.credit > 0 && <Figure label="Credit" value={balance.credit} tone="paid" />}
      </dl>
      <div className="actions person-actions">
        <button className="button primary" onClick={() => open({ kind: "payment", personId: id })}>Record a payment</button>
        {!person.archived && <button className="button secondary" onClick={() => open({ kind: "purchase", personId: id })}>Add purchase</button>}
        {balance.credit > 0 && store.canRecordCashReturned(id) && <button className="button secondary" onClick={() => open({ kind: "payout", personId: id })}>Record cash returned</button>}
      </div>
      <section className="section">
        <h2>Purchases</h2>
        {purchases.length ? <div className="card-stack">{purchases.map(purchase => <PurchaseCard key={purchase.id} purchase={purchase} open={open} remove={remove} />)}</div>
          : <p className="empty">No purchases yet.</p>}
      </section>
      <section className="section">
        <h2>Payments and cash returned</h2>
        {history.length ? <ul className="list-card history">{history.map(({ row, kind, date }) => <li key={row.id} className="history-row">
          <div><strong className="num">{formatTRY(row.amountMinor)}</strong>
            <p className="hint">{kind === "payment" ? "Payment received" : "Cash returned"} · <time dateTime={date}>{displayDate(date)}</time></p>
            {row.note && <p className="entry-note">{row.note}</p>}
          </div>
          <EntryButtons label={`${recordLabels[kind]} of ${formatTRY(row.amountMinor)}`}
            onEdit={() => kind === "payment" ? open({ kind, personId: id, record: row }) : open({ kind, personId: id, record: row })}
            onDelete={() => remove(kind, row)} />
        </li>)}</ul> : <p className="empty">No payments or cash returns yet.</p>}
      </section>
      <div className="actions manage-person">
        <button className="button secondary" onClick={() => open({ kind: "person", record: person })}>Edit person</button>
        {purchases.length > 0 || history.length > 0 ?
          <button className="button quiet" onClick={() => open({ kind: "archive", record: person })}>{person.archived ? "Unarchive person" : "Archive person"}</button> :
          <button className="button quiet" disabled={sync.restoreInProgress} onClick={() => remove("person", person)}>Delete person</button>}
      </div>
    </> : <section className="section"><h1 tabIndex={-1}>Person unavailable</h1><a href="#/" className="button secondary">Back to Home</a></section>}
  </>;
}

function deletedRecordLabel({ recordType, preImage }: Extract<Operation, { kind: "delete" }>, snapshot: StoreSnapshot) {
  const type = recordLabels[recordType];
  const label = type[0].toUpperCase() + type.slice(1);
  if (recordType === "refund" && preImage && "purchaseId" in preImage) {
    const purchaseId = preImage.purchaseId;
    const purchase = snapshot.records.purchases.find(row => row.id === purchaseId);
    const removed = snapshot.pendingUndo.find(({ op }) => op.kind === "delete" && op.recordType === "purchase" && op.recordId === purchaseId)?.op;
    const item = purchase?.item ?? (removed?.kind === "delete" ? recordName(removed.preImage) : null);
    if (item) return `${label} for ${item}`;
  }
  const name = recordName(preImage);
  if (!name) return label;
  return preImage && "amountMinor" in preImage ? `${label} of ${name}` : `${label} ${name}`;
}

export function UndoToasts() {
  const { snapshot, store, notify } = useLedgerUI();
  return <div className="toasts" aria-live="polite" aria-relevant="additions">
    {snapshot.pendingUndo.map(({ op }) => op.kind === "delete" && <div className="toast" key={op.id}>
      <p>{deletedRecordLabel(op, snapshot)} deleted</p>
      <button className="button small" disabled={snapshot.sync.restoreInProgress} onClick={() => {
        void store.undo(op.id).then(restored => notify(restored ? "Deletion undone." : "The undo window has ended."))
          .catch(error => notify(error instanceof Error ? error.message : String(error)));
      }}>Undo</button>
    </div>)}
  </div>;
}
