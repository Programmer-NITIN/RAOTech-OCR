"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Landmark,
  Loader2,
  Save,
  Search,
  Send,
  Settings2,
  Split,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LedgerSelect, type LedgerOption } from "@/components/LedgerSelect";
import { TallySyncBadge } from "@/components/TallySyncBadge";
import { TallySyncOverlay } from "@/components/TallySyncOverlay";
import { useTallyPush } from "@/components/tallyClient";
import { useToast } from "@/components/Toast";
import { BankBalanceBanner } from "@/components/BankBalanceBanner";
import { BankRulePanel } from "@/components/BankRulePanel";
import { BankSplitEditor } from "@/components/BankSplitEditor";
import {
  EMPTY_FILTERS,
  ROW_STATE_LABELS,
  assignClassification,
  assignLedger,
  assignSplit,
  buildBankVouchers,
  dateInputValue,
  editTxns,
  fetchBankTxns,
  filtersAreEmpty,
  money,
  rowAmount,
  saveTxns,
  setBankLedger,
  type BankFilters,
  type BankRowState,
  type BankTxnRow,
  type BankTxnsResponse,
} from "@/components/BankClient";

/**
 * Bank statement -> Payment / Receipt / Contra vouchers.
 *
 * The previous version of this screen mapped ledgers and stopped, because
 * nothing existed to turn a `BankTxn` into a `Voucher`. `buildBankVoucher` now
 * does, so the whole journey is here: bind the account, assign ledgers in bulk,
 * save, build, push — and watch each row go grey -> amber -> green -> red on the
 * same badge an invoice voucher uses, because by the time it is pushed a bank
 * row *is* an ordinary voucher.
 *
 * Three decisions worth stating outright:
 *
 *  - The grid is filtered on the server. Bulk assignment over a filtered
 *    selection is the highest-leverage thing on this screen — "every row whose
 *    narration says BANK CHARGES, all at once" — and it is only trustworthy if
 *    the selection means the same thing to the client and the server.
 *  - Contra is a manual override and never inferred. A transfer between two of
 *    the firm's own accounts is indistinguishable from a payment by looking at
 *    one side of it, so the machine does not get a vote.
 *  - The reconciliation banner is above the grid, not below it. Learning that a
 *    statement lost a row is worth much less after an hour of mapping.
 */

interface Txn {
  id: string;
  date: string | null;
  description: string;
  refNo: string | null;
  withdrawal: number;
  deposit: number;
  balance: number | null;
  classification?: string | null;
  confidence?: number | null;
  ledgerId: string | null;
  ledgerNameSnapshot: string | null;
}

interface Statement {
  id: string;
  fileName: string;
  bankName: string | null;
  accountNumber: string | null;
  status: string;
  txns: Txn[];
}

const STATE_CHIP: Record<BankRowState, string> = {
  blank: "bg-slate-100 text-slate-600",
  unsaved: "bg-amber-100 text-amber-700",
  saved: "bg-blue-100 text-blue-700",
  pushed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

const CLASSES: ("PAYMENT" | "RECEIPT" | "CONTRA")[] = ["PAYMENT", "RECEIPT", "CONTRA"];

export default function BankMapping({
  statement,
  ledgers: initialLedgers,
}: {
  statement: Statement;
  ledgers: LedgerOption[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [ledgers, setLedgers] = useState<LedgerOption[]>(initialLedgers);
  const [data, setData] = useState<BankTxnsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState<BankFilters>(EMPTY_FILTERS);
  const [queryDraft, setQueryDraft] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLedgerId, setBulkLedgerId] = useState<string | null>(null);
  const [splitFor, setSplitFor] = useState<BankTxnRow | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  /**
   * The server props are only the first paint.
   *
   * The page component predates the bank ledger, the split allocations, the
   * save gate and the per-row Tally state, and it is not this change's file to
   * edit. `GET /api/bank/statements/{id}/txns` returns all of it — plus the
   * reconciliation, recomputed rather than remembered — so the screen hydrates
   * from there and every filter change goes back to the same place.
   */
  const load = useCallback(
    async (next: BankFilters) => {
      setLoading(true);
      try {
        setData(await fetchBankTxns(statement.id, next));
      } catch (e) {
        toast(e instanceof Error ? e.message : "Could not load the statement", "error");
      } finally {
        setLoading(false);
      }
    },
    [statement.id, toast]
  );

  useEffect(() => {
    // Server state that changes without us — a subscription, not a computation.
    void load(filters);
  }, [load, filters]);

  const refresh = useCallback(() => load(filters), [load, filters]);

  const rows: BankTxnRow[] = useMemo(
    () =>
      data?.txns ??
      // Before the first fetch answers, render what the server component gave
      // us rather than an empty table.
      statement.txns.map((t) => ({
        ...t,
        classification: t.classification ?? null,
        confidence: t.confidence ?? null,
        allocations: [],
        saved: false,
        savedAt: null,
        voucherId: null,
        sync: null,
        state: (t.ledgerId ? "unsaved" : "blank") as BankRowState,
      })),
    [data, statement.txns]
  );

  const header = data?.statement;
  const counts = data?.counts;

  /* ------------------------------------------------------------- push */

  const onSettled = useCallback(() => {
    void refresh();
    router.refresh();
  }, [refresh, router]);
  const push = useTallyPush({ onSettled });

  const pushLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of rows) {
      if (r.voucherId) out[r.voucherId] = `${money(rowAmount(r))} · ${r.description.slice(0, 40)}`;
    }
    return out;
  }, [rows]);

  /* -------------------------------------------------------- selection */

  const selectedIds = useMemo(
    () => rows.filter((r) => selected.has(r.id)).map((r) => r.id),
    [rows, selected]
  );
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /* ----------------------------------------------------------- actions */

  async function run<T>(fn: () => Promise<T>, after?: (result: T) => void) {
    setBusy(true);
    try {
      const result = await fn();
      after?.(result);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Something went wrong", "error");
    } finally {
      setBusy(false);
    }
  }

  function applyBulkLedger() {
    if (!bulkLedgerId || !selectedIds.length) return;
    void run(
      () => assignLedger(statement.id, selectedIds, bulkLedgerId),
      (res) => {
        toast(`${res.updated} row(s) mapped.`, "success");
        if (res.warning) toast(res.warning, "info");
      }
    );
  }

  function saveSelected() {
    if (!selectedIds.length) return;
    void run(
      () => saveTxns(statement.id, selectedIds),
      (res) => {
        toast(`${res.saved} row(s) saved.`, "success");
        if (res.warning) toast(res.warning, "info");
        setSelected(new Set());
      }
    );
  }

  /**
   * Build, then push through the ordinary voucher path.
   *
   * `/api/bank/.../build` can queue the push itself, and does for API callers.
   * Here it is asked not to, so that `useTallyPush` owns the send — which is
   * what gives a bank voucher the same overlay, the same two-agreeing-polls
   * settle rule, and Tally's own rejection text verbatim, with no second copy
   * of any of it.
   */
  function buildAndPush() {
    const ids = selectedIds.length ? selectedIds : undefined;
    void run(
      () => buildBankVouchers(statement.id, ids),
      (res) => {
        if (res.failed.length) {
          toast(res.failed[0].messages[0] ?? "Some rows could not be built.", "error");
        }
        if (res.voucherIds.length) {
          void push.start(res.voucherIds);
        } else if (!res.failed.length) {
          toast("Nothing to send. Save the rows you want to post first.", "info");
        }
      }
    );
  }

  function setClass(txnId: string, classification: "PAYMENT" | "RECEIPT" | "CONTRA") {
    void run(() => assignClassification(statement.id, [txnId], classification));
  }

  function editRow(txnId: string, patch: { date?: string | null; description?: string }) {
    void run(() => editTxns(statement.id, [{ id: txnId, ...patch }]));
  }

  function chooseBankLedger(ledgerId: string) {
    void run(
      () => setBankLedger(statement.id, ledgerId),
      (res) => {
        if (res.warning) toast(res.warning, "info");
        else toast(`Bank account set to ${res.bankLedgerName}.`, "success");
      }
    );
  }

  function toggleState(state: BankRowState) {
    setSelected(new Set());
    setFilters((f) => ({
      ...f,
      states: f.states.includes(state)
        ? f.states.filter((s) => s !== state)
        : [...f.states, state],
    }));
  }

  function submitSearch() {
    setSelected(new Set());
    setFilters((f) => ({ ...f, q: queryDraft }));
  }

  function jumpTo(txnId: string) {
    rowRefs.current[txnId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const bankLedgerMissing = !!data && !header?.bankLedgerId;

  return (
    <div className="relative min-h-screen bg-[var(--spx-canvas)] text-[var(--spx-text)] space-y-5 p-6 md:p-10">
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={() => router.push("/transactions")} className="bg-[var(--spx-input-bg)] border-[var(--spx-border)] text-[var(--spx-text-secondary)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]">
          <ArrowLeft className="mr-2 h-4 w-4" /> Transactions
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setRulesOpen(true)} className="bg-[var(--spx-input-bg)] border-[var(--spx-border)] text-[var(--spx-text-secondary)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]">
            <Settings2 className="mr-2 h-4 w-4" /> Rules
          </Button>
          <Button variant="outline" disabled={busy || !selectedIds.length} onClick={saveSelected} className="bg-[var(--spx-input-bg)] border-[var(--spx-border)] text-[var(--spx-text-secondary)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]">
            <Save className="mr-2 h-4 w-4" /> Save {selectedIds.length || ""}
          </Button>
          <Button disabled={busy || bankLedgerMissing} onClick={buildAndPush} className="bg-white text-black hover:bg-zinc-200 font-medium">
            <Send className="mr-2 h-4 w-4" />
            {selectedIds.length ? `Send ${selectedIds.length} to Tally` : "Send saved rows to Tally"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10">
          <Landmark className="h-5 w-5 text-amber-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--spx-text)]">
            {header?.bankName || statement.bankName || "Bank Statement"}
          </h1>
          <p className="text-sm text-[var(--spx-muted)]">
            {(header?.accountNumber || statement.accountNumber)
              ? `A/C ${header?.accountNumber ?? statement.accountNumber} • `
              : ""}
            {data ? `${data.total} transactions` : `${statement.txns.length} transactions`}
          </p>
        </div>
      </div>

      {/* The bank side of every voucher this statement will produce. Bound once,
          here, because it is a property of the account and not of a row. */}
      <div
        className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${
          bankLedgerMissing
            ? "border-red-500/30 bg-red-500/10 text-red-300 dark:bg-red-950/30"
            : "border-[var(--spx-border)] bg-[var(--spx-card)] shadow-xl"
        }`}
      >
        <div className="min-w-[220px] flex-1">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--spx-muted)]">
            Bank account in Tally
          </p>
          <LedgerSelect
            ledgers={ledgers}
            value={header?.bankLedgerId ?? null}
            onChange={chooseBankLedger}
            onCreated={(led) => {
              setLedgers((prev) => [...prev, led]);
              chooseBankLedger(led.id);
            }}
            placeholder="Choose the account this statement belongs to…"
          />
        </div>
        {bankLedgerMissing && (
          <p className="max-w-xl text-sm text-red-300">
            Every Payment, Receipt and Contra needs the bank account itself on one side, and a
            statement row only shows the other side. Nothing can be sent to Tally until this is
            set. Mapping rows in the meantime is fine — the ledgers you choose are kept.
          </p>
        )}
      </div>

      {data && <BankBalanceBanner balance={data.balance} onJumpToBreak={jumpTo} />}

      {/* Filters. They compose — this is what makes "every blank row under ₹500
          whose narration says UPI" a single selection instead of three passes. */}
      <div className="space-y-3 rounded-xl border border-[var(--spx-border)] bg-[var(--spx-card)] p-4 shadow-xl">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-[var(--spx-muted)]" />
            <input
              value={queryDraft}
              onChange={(e) => setQueryDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitSearch()}
              placeholder="Search narration — then select all and map them in one go"
              className="w-full rounded-md border border-[var(--spx-border)] bg-[var(--spx-input-bg)] text-[var(--spx-text)] placeholder:text-[var(--spx-muted)] py-2 pl-8 pr-3 text-sm outline-none focus:border-[var(--spx-muted)]"
            />
          </div>
          <Button variant="outline" size="sm" onClick={submitSearch}>
            Search
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowFilters((s) => !s)}>
            {showFilters ? "Fewer filters" : "More filters"}
          </Button>
          {!filtersAreEmpty(filters) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQueryDraft("");
                setSelected(new Set());
                setFilters(EMPTY_FILTERS);
              }}
            >
              <X className="mr-1 h-4 w-4" /> Clear
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(ROW_STATE_LABELS) as BankRowState[]).map((state) => {
            const on = filters.states.includes(state);
            return (
              <button
                key={state}
                type="button"
                onClick={() => toggleState(state)}
                className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                  on ? "ring-2 ring-offset-1 ring-blue-400 " : ""
                }${STATE_CHIP[state]}`}
              >
                {ROW_STATE_LABELS[state]}
                {counts ? ` ${counts[state]}` : ""}
              </button>
            );
          })}
          {CLASSES.map((c) => {
            const on = filters.types.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setSelected(new Set());
                  setFilters((f) => ({
                    ...f,
                    types: on ? f.types.filter((t) => t !== c) : [...f.types, c],
                  }));
                }}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  on ? "border-emerald-500/30 bg-emerald-500/20 text-emerald-300" : "border-[var(--spx-border)] bg-[var(--spx-input-bg)] text-[var(--spx-muted)] hover:text-[var(--spx-text)]"
                }`}
              >
                {c[0] + c.slice(1).toLowerCase()}
              </button>
            );
          })}
        </div>

        {showFilters && (
          <div className="flex flex-wrap items-end gap-3 border-t border-[var(--spx-border)] pt-3">
            <Field label="From">
              <input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                className="rounded-md border border-[var(--spx-border)] bg-[var(--spx-input-bg)] text-[var(--spx-text)] px-2 py-1.5 text-sm outline-none"
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
                className="rounded-md border border-[var(--spx-border)] bg-[var(--spx-input-bg)] text-[var(--spx-text)] px-2 py-1.5 text-sm outline-none"
              />
            </Field>
            <Field label="Amount at least">
              <input
                inputMode="decimal"
                value={filters.min}
                onChange={(e) => setFilters((f) => ({ ...f, min: e.target.value }))}
                className="w-28 rounded-md border border-[var(--spx-border)] bg-[var(--spx-input-bg)] text-[var(--spx-text)] px-2 py-1.5 text-sm outline-none"
              />
            </Field>
            <Field label="Amount at most">
              <input
                inputMode="decimal"
                value={filters.max}
                onChange={(e) => setFilters((f) => ({ ...f, max: e.target.value }))}
                className="w-28 rounded-md border border-[var(--spx-border)] bg-[var(--spx-input-bg)] text-[var(--spx-text)] px-2 py-1.5 text-sm outline-none"
              />
            </Field>
          </div>
        )}

        {/* Bulk assignment. This is the whole point of the filters above it. */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--spx-border)] bg-[var(--spx-input-bg)] p-3">
          <span className="text-sm text-[var(--spx-muted)]">
            {selectedIds.length
              ? `${selectedIds.length} row(s) selected`
              : "Select rows to map them together"}
          </span>
          <div className="min-w-[220px] flex-1">
            <LedgerSelect
              ledgers={ledgers}
              value={bulkLedgerId}
              onChange={setBulkLedgerId}
              onCreated={(led) => {
                setLedgers((prev) => [...prev, led]);
                setBulkLedgerId(led.id);
              }}
              placeholder="Ledger to apply to the selection…"
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !bulkLedgerId || !selectedIds.length}
            onClick={applyBulkLedger}
            className="bg-white text-black hover:bg-zinc-200 font-medium"
          >
            Apply to {selectedIds.length || 0}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--spx-border)] bg-[var(--spx-card)] shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-[var(--spx-input-bg)] text-xs uppercase text-[var(--spx-muted)] border-b border-[var(--spx-border)]">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select every visible row"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    className="rounded border-zinc-700 bg-zinc-900"
                  />
                </th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Narration</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Withdrawal</th>
                <th className="px-3 py-2 text-right">Deposit</th>
                <th className="w-[280px] px-3 py-2 text-left">Ledger</th>
                <th className="px-3 py-2 text-left">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const locked = !!t.voucherId;
                return (
                  <tr
                    key={t.id}
                    ref={(el) => {
                      rowRefs.current[t.id] = el;
                    }}
                    className={`border-b border-[var(--spx-border)] align-top ${selected.has(t.id) ? "bg-zinc-800/60" : "hover:bg-[var(--spx-card-hover)]"}`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        checked={selected.has(t.id)}
                        onChange={() => toggleOne(t.id)}
                        className="rounded border-zinc-700 bg-zinc-900"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        disabled={locked}
                        defaultValue={dateInputValue(t.date)}
                        onBlur={(e) => {
                          const next = e.target.value;
                          if (next && next !== dateInputValue(t.date)) {
                            editRow(t.id, { date: new Date(`${next}T00:00:00`).toISOString() });
                          }
                        }}
                        className="w-[130px] rounded border border-transparent px-1 py-1 text-[var(--spx-text)] bg-transparent hover:border-[var(--spx-border)] focus:border-[var(--spx-muted)] focus:outline-none disabled:opacity-50"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        disabled={locked}
                        defaultValue={t.description}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next && next !== t.description) {
                            editRow(t.id, { description: next });
                          }
                        }}
                        className="w-full min-w-[220px] rounded border border-transparent px-1 py-1 text-[var(--spx-text)] bg-transparent hover:border-[var(--spx-border)] focus:border-[var(--spx-muted)] focus:outline-none disabled:opacity-50"
                      />
                      {t.refNo && <div className="px-1 text-xs text-[var(--spx-muted)]">Ref: {t.refNo}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {/* Contra never appears on its own — a transfer between the
                          firm's own accounts looks exactly like a payment from
                          this side. It is only ever chosen here. */}
                      <select
                        disabled={locked}
                        value={t.classification ?? ""}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next) setClass(t.id, next as "PAYMENT" | "RECEIPT" | "CONTRA");
                        }}
                        className="rounded border border-[var(--spx-border)] bg-[var(--spx-input-bg)] text-[var(--spx-text)] px-1.5 py-1 text-xs outline-none"
                      >
                        <option value="">Auto</option>
                        {CLASSES.map((c) => (
                          <option key={c} value={c}>
                            {c[0] + c.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-red-400">
                      {t.withdrawal ? money(t.withdrawal) : ""}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-emerald-400">
                      {t.deposit ? money(t.deposit) : ""}
                    </td>
                    <td className="px-3 py-2">
                      {t.allocations.length > 1 ? (
                        <div className="space-y-0.5 text-xs">
                          {t.allocations.map((a, i) => (
                            <div key={`${t.id}-alloc-${i}`} className="flex justify-between gap-2">
                              <span className="truncate text-[var(--spx-text)]">
                                {a.ledgerName ?? "—"}
                              </span>
                              <span className="shrink-0 text-[var(--spx-muted)]">{money(a.amount)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <LedgerSelect
                          ledgers={ledgers}
                          value={t.ledgerId}
                          onChange={(id) =>
                            void run(() => assignLedger(statement.id, [t.id], id))
                          }
                          onCreated={(led) => setLedgers((prev) => [...prev, led])}
                        />
                      )}
                      {!locked && (
                        <button
                          type="button"
                          onClick={() => setSplitFor(t)}
                          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-400 hover:text-emerald-300"
                        >
                          <Split className="h-3 w-3" />
                          {t.allocations.length > 1 ? "Edit split" : "Split"}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {t.sync ? (
                        <TallySyncBadge sync={t.sync} />
                      ) : (
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-bold ${STATE_CHIP[t.state]}`}
                        >
                          {ROW_STATE_LABELS[t.state]}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-[var(--spx-muted)]">
                    {loading ? (
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    ) : filtersAreEmpty(filters) ? (
                      "No transactions extracted from this statement."
                    ) : (
                      "No rows match these filters."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {counts && (
          <div className="flex flex-wrap gap-4 border-t border-[var(--spx-border)] bg-[var(--spx-card)] p-3 text-xs text-[var(--spx-muted)]">
            <span>{counts.blank} blank</span>
            <span>{counts.unsaved} unsaved</span>
            <span>{counts.saved} saved, ready to send</span>
            <span className="text-emerald-400 font-medium">{counts.pushed} in Tally</span>
            {counts.failed > 0 && (
              <span className="text-red-400 font-medium">{counts.failed} rejected by Tally</span>
            )}
          </div>
        )}
      </div>

      {splitFor && (
        <BankSplitEditor
          txn={splitFor}
          ledgers={ledgers}
          busy={busy}
          onLedgerCreated={(led) => setLedgers((prev) => [...prev, led])}
          onClose={() => setSplitFor(null)}
          onApply={(allocations) => {
            const id = splitFor.id;
            setSplitFor(null);
            void run(
              () => assignSplit(statement.id, [id], allocations),
              () => toast("Split saved.", "success")
            );
          }}
        />
      )}

      {rulesOpen && (
        <BankRulePanel
          statementId={statement.id}
          onApplied={() => void refresh()}
          onClose={() => setRulesOpen(false)}
        />
      )}

      <TallySyncOverlay push={push} labels={pushLabels} onClose={() => void refresh()} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      {children}
    </label>
  );
}
