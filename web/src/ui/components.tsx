import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { FamilyTabStore, SaveResult, StoreSnapshot } from "../data/index.ts";
import { formatTRY, parseAmount } from "../ledger/index.ts";
import type { LedgerRecord, Records } from "../types.ts";
import { dateInputText, displayDate, parseDateInput } from "./presentation.ts";

export const LedgerContext = createContext<{
  store: FamilyTabStore;
  snapshot: StoreSnapshot;
  notify: (message: string) => void;
} | null>(null);

export function useLedgerUI() {
  const value = useContext(LedgerContext);
  if (!value) throw new Error("Ledger context required");
  return value;
}

export type Commit<T> = (fields: T) => Promise<SaveResult>;

export function useSave(onSaved: (result: Extract<SaveResult, { status: "saved" }>) => void) {
  const [error, setError] = useState("");
  const [stale, setStale] = useState<Extract<SaveResult, { status: "stale" }> | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);

  async function submit(action: () => Promise<SaveResult>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setStale(null);
    try {
      const result = await action();
      switch (result.status) {
        case "saved": onSaved(result); break;
        case "stale": setStale(result); break;
        case "invalid": setError(result.error.reason); break;
        case "restoreInProgress": setError("Restore in progress. Wait for it to finish, then try again."); break;
        case "signedOut": setError("Sign in to continue."); break;
        case "notReady": setError("The ledger is still loading. Try again shortly."); break;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return { submit, error, setError, stale, setStale, busy };
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    heading.current?.focus();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} className="sheet" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="sheet-header">
      <h2 id={titleId} tabIndex={-1} ref={heading}>{title}</h2>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">×</button>
    </div>
    {children}
  </dialog>;
}

export function SaveForm({ children, onSave, busy, error, stale, onReapply, label = "Save", blocked }: {
  children: ReactNode; onSave: () => void; busy: boolean; error?: string; blocked?: boolean;
  stale?: ReturnType<typeof useSave>["stale"]; onReapply?: () => void; label?: string;
}) {
  const { snapshot } = useLedgerUI();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!stale && !snapshot.sync.restoreInProgress && !blocked && !busy) onSave();
  }
  // Browsers cannot focus an invalid field inside a collapsed <details>, so
  // they block Save without showing why. Open the section and show the field.
  function revealInvalid(event: FormEvent) {
    const field = event.target as HTMLElement;
    const section = field.closest("details");
    if (!section || section.open) return;
    section.open = true;
    requestAnimationFrame(() => {
      field.focus();
      (field as HTMLInputElement).reportValidity?.();
    });
  }
  return <form className="sheet-form" onSubmit={submit} onInvalidCapture={revealInvalid}>
    <div className="form-fields">{children}
      {stale && <div role="alert" className="notice">
        <p>{stale.current ? "This record changed while you were editing. Review the current version before reapplying your changes." : "This record was removed while you were editing."}</p>
        {stale.current && <RecordSummary records={snapshot.records} record={stale.current} />}
        {stale.current && onReapply && <button type="button" className="button secondary" onClick={onReapply}>Reapply my changes</button>}
      </div>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
    <div className="sheet-footer">
      {snapshot.sync.restoreInProgress && <p role="status" className="hint">Restore in progress. Saving is temporarily unavailable.</p>}
      <button className="button primary" disabled={busy || blocked || !!stale || snapshot.sync.restoreInProgress}>{busy ? "Saving…" : label}</button>
    </div>
  </form>;
}

export function AmountField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const hint = `${id}-hint`;
  const parsed = parseAmount(value);
  return <div className="field"><label htmlFor={id}>{label}</label>
    <input id={id} required inputMode="decimal" className="num" value={value} onChange={event => onChange(event.target.value)}
      placeholder="0,00" aria-describedby={hint} aria-invalid={!!value && !parsed.ok} />
    <span id={hint} className="hint num" aria-live="polite">{parsed.ok ? formatTRY(parsed.minor) : value ? "Enter a valid amount in TL." : "Amount in TL"}</span>
  </div>;
}

export function DateField({ label, value, onChange, min, max }: {
  label: string; value: string; onChange: (value: string) => void; min?: string; max?: string;
}) {
  const id = useId();
  const hint = `${id}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => dateInputText(value));
  // The last date this field and its parent agreed on. Only an outside change
  // to the value replaces the text, so an invalid entry stays visible and
  // keeps blocking Save instead of reverting to the previous date.
  const synced = useRef(value);
  useEffect(() => {
    if (value === synced.current) return;
    synced.current = value;
    setText(dateInputText(value));
  }, [value]);
  const parsed = parseDateInput(text);
  const error = !text ? "Enter a date." : !parsed ? "Enter the date as day.month.year."
    : min && parsed < min ? `Choose ${displayDate(min)} or later.`
      : max && parsed > max ? `Choose ${displayDate(max)} or earlier.` : "";
  useEffect(() => {
    input.current?.setCustomValidity(error);
  }, [error]);
  return <div className="field"><label htmlFor={id}>{label}</label>
    <div className="date-input">
      <input ref={input} id={id} required className="num" inputMode="numeric" autoComplete="off" placeholder="DD.MM.YYYY"
        value={text} aria-describedby={hint} aria-invalid={!!text && !!error}
        onBlur={() => {
          if (parsed) setText(dateInputText(parsed));
        }}
        onChange={event => {
          setText(event.target.value);
          const next = parseDateInput(event.target.value);
          if (next) {
            synced.current = next;
            onChange(next);
          }
        }} />
      <span className="date-picker" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" />
        </svg>
        <input type="date" tabIndex={-1} value={value} min={min} max={max}
          onClick={event => {
            try { event.currentTarget.showPicker(); } catch { /* The tap opens the native picker. */ }
          }}
          onChange={event => {
            if (event.target.value) onChange(event.target.value);
          }} />
      </span>
    </div>
    <span id={hint} className="hint" aria-live="polite">{text && error ? error : parsed ? displayDate(parsed) : "Day.month.year"}</span>
  </div>;
}

export function Chip({ children, selected, onClick }: { children: ReactNode; selected?: boolean; onClick: () => void }) {
  return <button className="choice" type="button" aria-pressed={selected} onClick={onClick}>{children}</button>;
}

export function RecordSummary({ records, record }: { records: Records; record: LedgerRecord | null }) {
  if (!record) return <p className="hint">No record</p>;
  const rows: [string, ReactNode][] = [];
  if ("personId" in record) rows.push(["Person", records.people.find(person => person.id === record.personId)?.name ?? record.personId]);
  if ("purchaseId" in record) rows.push(["Purchase", records.purchases.find(purchase => purchase.id === record.purchaseId)?.item ?? record.purchaseId]);
  if ("timeZone" in record) rows.push(["Time zone", record.timeZone]);
  if ("name" in record) rows.push(["Name", record.name], ["Payday", record.payday ?? "None"], ["Archived", record.archived ? "Yes" : "No"]);
  if ("item" in record) {
    rows.push(["Item", record.item], ["Original total", formatTRY(record.totalMinor)], ["Purchased", displayDate(record.boughtOn)]);
    if (record.plan === "installments") {
      rows.push(["Plan", `${record.count} installments`], ["First due", record.firstDue && displayDate(record.firstDue)], ["Monthly anchor", record.dueDay]);
    } else rows.push(["Plan", "All at once"], ["Due", record.dueDate ? displayDate(record.dueDate) : "When they can"]);
  }
  if ("amountMinor" in record) {
    const date = "paidOn" in record ? record.paidOn : "refundedOn" in record ? record.refundedOn : record.paidOutOn;
    rows.push(["Amount", formatTRY(record.amountMinor)], ["Date", displayDate(date)]);
  }
  if ("note" in record) rows.push(["Note", record.note ?? "None"]);
  return <dl className="summary-list">{rows.map(([label, value]) =>
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function Figure({ label, value, detail, tone }: {
  label: string; value: number; detail?: ReactNode; tone?: "paid" | "expected";
}) {
  return <div className="figure">
    <dt>{label}</dt>
    <dd className={`num ${tone ?? ""}`}>{formatTRY(value)}</dd>
    {detail && <dd className="hint">{detail}</dd>}
  </div>;
}

export function personURL(id: string) {
  return `#/person/${encodeURIComponent(id)}`;
}
