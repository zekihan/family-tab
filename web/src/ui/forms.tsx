import { useId, useRef, useState } from "react";
import type { EditToken, SaveResult } from "../data/index.ts";
import {
  defaultInstallmentStart, dueShortcuts, formatAmountInput, formatTRY, installmentPreview,
  isValidTimeZone, lastDayOfMonth, MAX_AMOUNT_MINOR, parseAmount, paymentChips,
} from "../ledger/index.ts";
import type { Payment, Payout, Plan, RecordByType, RecordType, Refund } from "../types.ts";
import { AmountField, Chip, DateField, SaveForm, useLedgerUI, useSave } from "./components.tsx";
import type { Commit } from "./components.tsx";
import { displayDate, patchBetween, paymentLabels, purchaseDate } from "./presentation.ts";

type Fields<T extends RecordType> = Omit<RecordByType[T], "id" | "version">;
type Saved = Extract<SaveResult, { status: "saved" }>;
type FormTarget<T extends RecordType> = {
  initial?: RecordByType[T];
  token?: EditToken;
  commit?: Commit<Fields<T>>;
  onSaved: (result: Saved) => void;
};

function useRecordForm<T extends Exclude<RecordType, "settings">>(type: T, target: FormTarget<T>) {
  const { store } = useLedgerUI();
  const [token, setToken] = useState(target.token);
  const save = useSave(target.onSaved);
  function onReapply() {
    if (!save.stale?.current) return;
    setToken({ generation: save.stale.generation, version: save.stale.current.version });
    save.setStale(null);
  }
  function commit(fields: Fields<T>) {
    if (target.commit) return target.commit(fields);
    if (target.initial && token) return store.updateRecord(type, target.initial.id, token, patchBetween(target.initial, fields));
    return store.createRecord(type, fields);
  }
  return { ...save, commit, persist: (fields: Fields<T>) => void save.submit(() => commit(fields)), onReapply };
}

const installmentCounts = [2, 3, 4, 6, 9, 12];
const dueLabels = {
  none: "No fixed date", payday: "Their payday", endOfMonth: "End of month", inTwoWeeks: "In 2 weeks", custom: "Custom date",
};
type DueChoice = keyof typeof dueLabels;

export function PurchaseForm({ personId, ...target }: FormTarget<"purchase"> & { personId?: string }) {
  const { snapshot } = useLedgerUI();
  const today = snapshot.ledger!.today;
  const { initial } = target;
  const active = snapshot.records.people.filter(person => !person.archived);
  const eligible = snapshot.records.people.filter(person => !person.archived || person.id === initial?.personId);
  const [who, setWho] = useState(initial?.personId ?? personId ?? (active.length === 1 ? active[0].id : ""));
  const person = eligible.find(person => person.id === who);
  const [newPerson, setNewPerson] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPayday, setNewPayday] = useState("");
  const [item, setItem] = useState(initial?.item ?? "");
  const [amount, setAmount] = useState(initial ? formatAmountInput(initial.totalMinor) : "");
  const [plan, setPlan] = useState<Plan>(initial?.plan ?? "once");
  const [choice, setChoice] = useState<DueChoice>(initial?.dueDate ? "custom" : "none");
  const [customDue, setCustomDue] = useState(initial?.dueDate ?? today);
  const [countText, setCountText] = useState(String(initial?.count ?? 6));
  const [other, setOther] = useState(!!initial?.count && !installmentCounts.includes(initial.count));
  const [first, setFirst] = useState(initial?.firstDue ? { firstDue: initial.firstDue, dueDay: initial.dueDay! } : null);
  const [boughtOn, setBoughtOn] = useState<string | null>(null);
  const [note, setNote] = useState(initial?.note ?? "");
  const save = useRecordForm("purchase", target);
  const { store } = useLedgerUI();
  const newNameInput = useRef<HTMLInputElement>(null);

  const payday = newPerson ? (newPayday ? Number(newPayday) : null) : person?.payday ?? null;
  const shortcuts = dueShortcuts(today, payday);
  const defaultStart = defaultInstallmentStart(today, payday);
  const start = first ?? defaultStart;
  const onceDue = choice === "none" ? null : choice === "custom" ? customDue : shortcuts[choice];
  const due = plan === "once" ? onceDue : start.firstDue;
  const date = purchaseDate(boughtOn, initial?.boughtOn ?? today, due);
  const parsed = parseAmount(amount);
  const count = Number(countText);
  const preview = plan === "installments" && parsed.ok ? installmentPreview(parsed.minor, count, start.firstDue, start.dueDay) : null;
  const invalidPlan = plan === "installments" && parsed.ok && !preview;
  const previewText = preview && (preview.minAmount === preview.maxAmount
    ? `${count} × ${formatTRY(preview.minAmount)}` : `${count} installments of ${formatTRY(preview.minAmount)} to ${formatTRY(preview.maxAmount)}`);

  function selectPerson(id: string) {
    setNewPerson(false);
    setWho(id);
    if (choice === "payday" && eligible.find(row => row.id === id)?.payday == null) setChoice("none");
  }

  function savePurchase() {
    if (!parsed.ok || date.invalid || invalidPlan || !item.trim() || (!newPerson && !person)) {
      save.setError("Choose a person and enter a purchase, amount, and valid dates.");
      return;
    }
    const fields: Fields<"purchase"> = {
      personId: who, item: item.trim(), totalMinor: parsed.minor, boughtOn: date.date, plan,
      dueDate: plan === "once" ? onceDue : null, count: plan === "installments" ? count : null,
      firstDue: plan === "installments" ? start.firstDue : null, dueDay: plan === "installments" ? start.dueDay : null,
      note: note === (initial?.note ?? "") ? initial?.note ?? null : note.trim() || null,
    };
    if (!newPerson) {
      save.persist(fields);
      return;
    }
    if (!newName.trim()) {
      save.setError("Enter the new person’s name.");
      return;
    }
    void save.submit(async () => {
      const result = await store.createRecord("person", { name: newName.trim(), payday, archived: false });
      if (result.status !== "saved") return result;
      fields.personId = result.recordId;
      setWho(result.recordId);
      setNewPerson(false);
      return save.commit(fields);
    });
  }

  return <SaveForm {...save} onSave={savePurchase} blocked={date.invalid || invalidPlan} label={target.commit ? "Resubmit" : "Save"}>
    <fieldset><legend>Who</legend>
      <div className="choices">
        {eligible.map(row => <Chip key={row.id} selected={!newPerson && who === row.id} onClick={() => selectPerson(row.id)}>
          {row.name}{row.archived ? " (archived)" : ""}
        </Chip>)}
        <Chip selected={newPerson} onClick={() => {
          setNewPerson(!newPerson);
          if (!newPerson) requestAnimationFrame(() => newNameInput.current?.focus());
        }}>+ New person</Chip>
      </div>
    </fieldset>
    {newPerson && <div className="inline-fields">
      <label className="field">Name<input ref={newNameInput} required value={newName} onChange={event => setNewName(event.target.value)} /></label>
      <label className="field">Payday (optional)<input type="number" min="1" max="31" step="1" value={newPayday} onChange={event => setNewPayday(event.target.value)} /></label>
    </div>}
    <label className="field">What<input required value={item} placeholder="e.g. Vacuum cleaner" onChange={event => setItem(event.target.value)} /></label>
    <AmountField label="Total price" value={amount} onChange={setAmount} />
    <fieldset><legend>How they pay back</legend>
      <div className="segmented">
        <Chip selected={plan === "once"} onClick={() => setPlan("once")}>All at once</Chip>
        <Chip selected={plan === "installments"} onClick={() => setPlan("installments")}>In installments</Chip>
      </div>
    </fieldset>
    {plan === "once" ? <fieldset><legend>Due date</legend>
      <div className="choices">
        {(Object.keys(dueLabels) as DueChoice[]).filter(key => key !== "payday" || shortcuts.payday).map(key =>
          <Chip key={key} selected={choice === key} onClick={() => setChoice(key)}>{dueLabels[key]}</Chip>)}
      </div>
      {choice === "custom" ? <DateField label="Custom due date" value={customDue} onChange={setCustomDue} />
        : onceDue && <p className="hint">{displayDate(onceDue)}</p>}
    </fieldset> : <>
      <fieldset><legend>Installments</legend>
        <div className="choices">
          {installmentCounts.map(value => <Chip key={value} selected={!other && count === value}
            onClick={() => { setCountText(String(value)); setOther(false); }}>{value}</Chip>)}
          <Chip selected={other} onClick={() => setOther(true)}>Other</Chip>
        </div>
      </fieldset>
      {other && <label className="field">Number of installments
        <input type="number" required min="2" max="120" step="1" value={countText} onChange={event => setCountText(event.target.value)} />
      </label>}
      <DateField label="First due date" value={start.firstDue} onChange={value => {
        setFirst(value === defaultStart.firstDue ? defaultStart : { firstDue: value, dueDay: Number(value.slice(8)) });
      }} />
      {start.firstDue && start.firstDue === lastDayOfMonth(start.firstDue) && <label className="check">
        <input type="checkbox" checked={start.dueDay === 31} disabled={start.firstDue.endsWith("-31")}
          onChange={event => {
            const naturalAnchor = start.firstDue === defaultStart.firstDue && defaultStart.dueDay !== 31
              ? defaultStart.dueDay : Number(start.firstDue.slice(8));
            setFirst({ firstDue: start.firstDue, dueDay: event.target.checked ? 31 : naturalAnchor });
          }} />
        Last day of each month
      </label>}
      <div aria-live="polite">
        {preview && <div className="notice installment-preview"><strong className="num">{previewText}</strong>
          <p>{displayDate(preview.first)} to {displayDate(preview.last)}</p></div>}
        {invalidPlan && <p className="error-text">Choose a valid first date and 2 to 120 installments of at least one kuruş each.</p>}
      </div>
    </>}
    <details className="optional-fields">
      <summary>Purchase date and note</summary>
      <DateField label="Purchase date" value={date.date} onChange={setBoughtOn} max={today} />
      <label className="field">Note<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
    </details>
    {date.backdated && <p className="notice" role="status">Purchase date moved back to {displayDate(date.date)} to match the first due date.</p>}
    {date.invalid && <p className="error-text" role="alert">The purchase date must be on or before the first due date.</p>}
  </SaveForm>;
}

export function PersonForm(target: FormTarget<"person">) {
  const { initial } = target;
  const [name, setName] = useState(initial?.name ?? "");
  const [payday, setPayday] = useState(initial?.payday == null ? "" : String(initial.payday));
  const [archived, setArchived] = useState(initial?.archived ?? false);
  const save = useRecordForm("person", target);
  const paydayId = useId();
  return <SaveForm {...save} onSave={() => save.persist({ name: name.trim(), payday: payday ? Number(payday) : null, archived })}
    label={target.commit ? "Resubmit" : "Save"}>
    <label className="field">Name<input required value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="field"><label htmlFor={paydayId}>Payday (optional)</label>
      <input id={paydayId} aria-describedby={`${paydayId}-hint`} type="number" min="1" max="31" step="1" value={payday} onChange={event => setPayday(event.target.value)} />
      <span id={`${paydayId}-hint`} className="hint">Day of the month. Changes apply to defaults for new purchases.</span>
    </div>
    {target.commit && <label className="check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} /> Archived</label>}
  </SaveForm>;
}

type CashTarget =
  | ({ type: "payment"; personId: string } & FormTarget<"payment">)
  | ({ type: "payout"; personId: string } & FormTarget<"payout">)
  | ({ type: "refund"; purchaseId: string } & FormTarget<"refund">);

export function CashForm(target: CashTarget) {
  const { snapshot, store } = useLedgerUI();
  const today = snapshot.ledger!.today;
  const initial: Payment | Payout | Refund | undefined = target.initial;
  const [personId, setPerson] = useState("personId" in target ? target.personId : "");
  const [purchaseId, setPurchase] = useState("purchaseId" in target ? target.purchaseId : "");
  const purchase = snapshot.records.purchases.find(row => row.id === purchaseId);
  const person = snapshot.records.people.find(row => row.id === personId);
  const chips = target.type === "payment" && !initial && person
    ? paymentChips(snapshot.ledger!, snapshot.records, person.id).filter(chip => chip.amountMinor <= MAX_AMOUNT_MINOR) : [];
  const [amount, setAmount] = useState(initial ? formatAmountInput(initial.amountMinor) : chips.length ? formatAmountInput(chips[0].amountMinor) : "");
  const [date, setDate] = useState(initial ? "paidOn" in initial ? initial.paidOn : "refundedOn" in initial ? initial.refundedOn : initial.paidOutOn : today);
  const [note, setNote] = useState(initial?.note ?? "");
  const [token, setToken] = useState(target.token);
  const save = useSave(target.onSaved);
  const amountValue = parseAmount(amount);
  const undoBlocked = target.type === "payout" && !initial && !store.canRecordCashReturned(personId);
  const credit = snapshot.ledger!.balances[personId]?.credit ?? 0;
  const personPicker = useId();

  function persist() {
    if (!amountValue.ok) {
      save.setError("Enter a valid amount in TL.");
      return;
    }
    const cash = { amountMinor: amountValue.minor, note: note === (initial?.note ?? "") ? initial?.note ?? null : note.trim() || null };
    void save.submit(() => {
      switch (target.type) {
        case "payment": {
          const fields = { ...cash, personId, paidOn: date };
          if (target.commit) return target.commit(fields);
          return target.initial && token ? store.updateRecord("payment", target.initial.id, token, patchBetween(target.initial, fields)) : store.createRecord("payment", fields);
        }
        case "refund": {
          const fields = { ...cash, purchaseId, refundedOn: date };
          if (target.commit) return target.commit(fields);
          return target.initial && token ? store.updateRecord("refund", target.initial.id, token, patchBetween(target.initial, fields)) : store.createRecord("refund", fields);
        }
        case "payout": {
          const fields = { ...cash, personId, paidOutOn: date };
          if (target.commit) return target.commit(fields);
          return target.initial && token ? store.updateRecord("payout", target.initial.id, token, patchBetween(target.initial, fields)) : store.createRecord("payout", fields);
        }
      }
    });
  }

  return <SaveForm {...save} onSave={persist} blocked={undoBlocked} label={target.commit ? "Resubmit" : "Save"} onReapply={() => {
    if (!save.stale?.current) return;
    setToken({ generation: save.stale.generation, version: save.stale.current.version });
    save.setStale(null);
  }}>
    {target.type === "refund" ? <>
      {target.commit ? <label className="field">Purchase
        <select required value={purchaseId} onChange={event => setPurchase(event.target.value)}>
          <option value="">Choose a purchase</option>
          {snapshot.records.purchases.map(row => <option key={row.id} value={row.id}>{row.item} · {snapshot.records.people.find(person => person.id === row.personId)?.name}</option>)}
        </select>
      </label> : <p className="hint">Shop refund for {purchase?.item ?? "purchase"}</p>}
      {purchase && <p className="notice num">Original total <strong>{formatTRY(purchase.totalMinor)}</strong></p>}
    </> : <>
      {initial || target.commit ? <div className="field">
        <label htmlFor={personPicker}>Who</label>
        <select id={personPicker} required value={personId} onChange={event => setPerson(event.target.value)}>
          <option value="">Choose a person</option>
          {snapshot.records.people.map(row => <option key={row.id} value={row.id}>{row.name}{row.archived ? " (archived)" : ""}</option>)}
        </select>
      </div> : <p className="hint">{person?.name}</p>}
      {target.type === "payout" && <p className="notice num">Available credit <strong>{formatTRY(credit)}</strong>
        {undoBlocked && <span className="hint"> · Available after the undo window ends.</span>}
      </p>}
    </>}
    {chips.length > 0 && <fieldset><legend>Quick amounts</legend>
      <div className="choices">{chips.map(chip => <Chip key={chip.kind} onClick={() => setAmount(formatAmountInput(chip.amountMinor))}>
        <span>{paymentLabels[chip.kind]}</span> <strong className="num">{formatTRY(chip.amountMinor)}</strong>
        {chip.shortfallMinor > 0 && <small className="hint">Includes {formatTRY(chip.shortfallMinor)} cash shortfall</small>}
      </Chip>)}</div>
    </fieldset>}
    <AmountField label="Amount" value={amount} onChange={setAmount} />
    <DateField label="Date" value={date} onChange={setDate} min={purchase?.boughtOn} max={today} />
    <label className="field">Note (optional)<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
    {target.type === "payment" && <p className="hint">Payments first cover any cash shortfall, then dated amounts starting with the earliest due, then purchases without a date. Anything left becomes credit.</p>}
  </SaveForm>;
}

export function ZoneForm({ initial, token: opened, commit, onSaved }: FormTarget<"settings">) {
  const { store, snapshot } = useLedgerUI();
  const [zone, setZone] = useState(initial?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const [token, setToken] = useState(opened);
  const save = useSave(onSaved);
  const zoneId = useId();
  const zonesId = `${zoneId}-options`;
  function persist() {
    const timeZone = zone.trim();
    if (!isValidTimeZone(timeZone)) {
      save.setError("Enter a valid IANA time zone, such as Europe/Istanbul.");
      return;
    }
    const fields = { timeZone, currency: "TRY" as const };
    void save.submit(() => commit ? commit(fields) : initial && token
      ? store.updateRecord("settings", initial.id, token, patchBetween(initial, fields)) : store.setup(timeZone));
  }
  return <SaveForm {...save} onSave={persist} blocked={!snapshot.generation}
    label={commit ? "Resubmit" : initial ? "Save" : "Confirm time zone"} onReapply={() => {
      if (!save.stale?.current) return;
      setToken({ generation: save.stale.generation, version: save.stale.current.version });
      save.setStale(null);
    }}>
    <div className="field"><label htmlFor={zoneId}>Ledger time zone</label>
      <input id={zoneId} aria-describedby={`${zoneId}-hint`} required list={zonesId} value={zone} onChange={event => setZone(event.target.value)} autoComplete="off" />
      <datalist id={zonesId}>{Intl.supportedValuesOf?.("timeZone").map(value => <option key={value} value={value} />)}</datalist>
      <span id={`${zoneId}-hint`} className="hint">Controls today and date shortcuts across devices. Saved dates stay the same.</span>
    </div>
  </SaveForm>;
}
