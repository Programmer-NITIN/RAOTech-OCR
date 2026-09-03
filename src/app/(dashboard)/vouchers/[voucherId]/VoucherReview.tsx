"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LedgerSelect, type LedgerOption, type LedgerSelectHandle } from "@/components/LedgerSelect";
import { TallySyncOverlay } from "@/components/TallySyncOverlay";
import { TallySyncBadge } from "@/components/TallySyncBadge";
import { useTallyPush, useVoucherSyncs } from "@/components/tallyClient";
import { useToast } from "@/components/Toast";
import { ArrowLeft, Save, AlertTriangle, Send, CheckCircle2, Download } from "lucide-react";

interface Line {
  id: string;
  ledgerId: string | null;
  ledgerNameSnapshot: string | null;
  role: string;
  debit: number;
  credit: number;
  confidence: number | null;
  mappedVia: string | null;
  hsnCode: string | null;
  gstRate: number | null;
  sortOrder: number;
}

interface Voucher {
  id: string;
  invoiceId?: string | null;
  voucherType: string;
  status: string;
  date: string;
  narration: string | null;
  totalDebit: number;
  totalCredit: number;
  roundOff: number;
  lines: Line[];
  invoice: any;
}

const money = (n: number) => `₹${(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

function formatItemAmount(item: Record<string, any>) {
  return Number(item.debit ?? item.price ?? item.amount ?? item.total ?? item.credit ?? 0);
}

function getItemLabel(item: Record<string, any>) {
  return (
    String(item.selected_item_name ?? item.item_name ?? item.name ?? item.description ?? "Item").trim() ||
    "Item"
  );
}

function getExtractedItemLabel(item: Record<string, any>) {
  return String(item.item_name ?? item.name ?? item.description ?? "Item").trim() || "Item";
}

function ConfidenceChip({ line }: { line: Line }) {
  if (!line.ledgerId)
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">Needs ledger</span>;
  const c = line.confidence ?? 0;
  if (line.mappedVia === "MANUAL")
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">Manual</span>;
  if (c >= 0.9)
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">High</span>;
  if (c >= 0.6)
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700">Review</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">Low</span>;
}

const EDITABLE_ROLES = new Set(["PARTY", "ITEM", "CGST", "SGST", "IGST"]);
const TYPES = ["PURCHASE", "SALE", "CREDIT_NOTE", "DEBIT_NOTE"];

export default function VoucherReview({
  voucher: initial,
  ledgers: initialLedgers,
  prevId,
  nextId,
}: {
  voucher: Voucher;
  ledgers: LedgerOption[];
  prevId?: string | null;
  nextId?: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [ledgers, setLedgers] = useState<LedgerOption[]>(initialLedgers);
  const [lines, setLines] = useState<Line[]>(initial.lines);
  const [voucherType, setVoucherType] = useState(initial.voucherType);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"items" | "ledger">(() => {
    const extractedItems = initial.invoice?.extractedData?.items;
    const hasPendingItemReview = Array.isArray(extractedItems) && extractedItems.length > 0 && !initial.invoice?.extractedData?.item_name_mapping_complete;
    return hasPendingItemReview ? "items" : "ledger";
  });
  const [itemNames, setItemNames] = useState<string[]>(() => {
    const extractedItems = Array.isArray(initial.invoice?.extractedData?.items) ? initial.invoice.extractedData.items : [];
    return extractedItems.map((item: Record<string, any>) => getItemLabel(item));
  });
  const [status, setStatus] = useState(initial.status);
  const firstUnmappedRef = useRef<LedgerSelectHandle | null>(null);

  // Where Tally stands on this voucher. The server page does not carry it, and
  // it changes while the screen is open, so it is read here.
  const voucherIds = useMemo(() => [initial.id], [initial.id]);
  const { syncs, refresh: refreshSyncs } = useVoucherSyncs(voucherIds);
  const sync = syncs[initial.id];
  const push = useTallyPush({
    onSettled: () => {
      void refreshSyncs();
      router.refresh();
    },
  });

  const inv = initial.invoice || {};
  const invoiceId = initial.invoice?.id ?? null;
  const extractedItems = Array.isArray(inv.extractedData?.items) ? inv.extractedData.items : [];
  const itemNameOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of extractedItems) {
      const label = getExtractedItemLabel(item);
      if (!seen.has(label)) seen.add(label);
    }
    return Array.from(seen);
  }, [extractedItems]);
  const hasUnmapped = lines.some((l) => l.ledgerId === null);
  const totalDebit = useMemo(() => lines.reduce((s, l) => s + l.debit, 0), [lines]);
  const totalCredit = useMemo(() => lines.reduce((s, l) => s + l.credit, 0), [lines]);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
  const posted = sync?.state === "POSTED" || status === "POSTED";
  // Editing stops once Tally has the voucher; an XML download still locks too,
  // since the file the user imported by hand was built from these lines.
  const locked = posted || status === "EXPORTED_DEMO";

  function setLineLedger(lineId: string, ledgerId: string) {
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? {
              ...l,
              ledgerId,
              ledgerNameSnapshot: ledgers.find((x) => x.id === ledgerId)?.name ?? null,
              mappedVia: "MANUAL",
              confidence: 1,
            }
          : l
      )
    );
  }

  function persistLinesInBackground(current: Line[] = lines) {
    fetch(`/api/vouchers/${initial.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: current.map((l) => ({ id: l.id, ledgerId: l.ledgerId })) }),
    }).catch(() => {});
  }

  function updateItemName(index: number, nextName: string) {
    setItemNames((prev) => prev.map((value, i) => (i === index ? nextName : value)));
  }

  function buildPersistedExtractedData() {
    const updatedItems = extractedItems.map((item: Record<string, any>, index: number) => ({
      ...item,
      selected_item_name: itemNames[index] || getItemLabel(item),
    }));
    return {
      ...inv.extractedData,
      items: updatedItems,
      item_name_mapping_complete: true,
    };
  }

  async function persistItemNames() {
    if (!invoiceId || !extractedItems.length) return;

    const res = await fetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extractedData: buildPersistedExtractedData() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Failed to save item names");
    }
  }

  async function changeType(next: string) {
    if (next === voucherType || locked) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/vouchers/${initial.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucherType: next }),
      });
      const data = await res.json();
      if (res.ok && data.voucher) {
        setVoucherType(data.voucher.voucherType);
        setLines(data.voucher.lines);
      } else setError(data.error || "Failed to change type");
    } finally {
      setSaving(false);
    }
  }

  function saveLedgerMapping() {
    setError(null);
    setSaving(true);
    (async () => {
      try {
        await persistItemNames();
        persistLinesInBackground();
        setSavedFlash(true);
        toast("Mapping saved", "success");
        window.setTimeout(() => setSavedFlash(false), 1500);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save mapping";
        setError(message);
        toast(message, "error");
      } finally {
        setSaving(false);
      }
    })();
  }

  async function saveCurrentStep() {
    if (stage === "items") {
      setStage("ledger");
      toast("Item names ready for final save", "success");
      return;
    }
    saveLedgerMapping();
  }

  async function approve(): Promise<boolean> {
    const res = await fetch(`/api/vouchers/${initial.id}/approve`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Approve failed");
      toast(data.error || "Approve failed", "error");
      return false;
    }
    setStatus("APPROVED");
    return true;
  }

  /** Approve, then hand the voucher to the connector. The overlay follows the
   *  real sync row from here on — there is no timer anywhere in this path. */
  async function approveAndPush() {
    if (stage === "items" || hasUnmapped || !balanced) return;
    setError(null);
    persistLinesInBackground();
    if (!(await approve())) return;
    await push.start([initial.id]);
  }

  /** Kept for workspaces with no connector paired: the same XML, by hand. */
  async function downloadXml() {
    if (hasUnmapped || !balanced) return;
    setError(null);
    persistLinesInBackground();
    try {
      const res = await fetch("/api/export/tally", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucherIds: [initial.id] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tally_${initial.id.slice(0, 8)}.xml`;
      a.click();
      URL.revokeObjectURL(url);
      toast("XML downloaded — import it in Tally to post it.", "info");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Tally export failed";
      setError(message);
      toast(message, "error");
    }
  }

  // Keyboard shortcuts: A approve, J/K nav, E edit first unmapped, S save
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)
        return;
      const key = e.key.toLowerCase();
      if (key === "a" && !locked && stage === "ledger") {
        e.preventDefault();
        void approveAndPush();
      } else if (key === "s") {
        e.preventDefault();
        void saveCurrentStep();
      } else if (key === "e" && !locked) {
        e.preventDefault();
        firstUnmappedRef.current?.focusOpen();
      } else if (key === "j" && nextId) {
        e.preventDefault();
        router.push(`/vouchers/${nextId}`);
      } else if (key === "k" && prevId) {
        e.preventDefault();
        router.push(`/vouchers/${prevId}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, hasUnmapped, balanced, nextId, prevId, lines]);

  return (
    <div className="p-6 md:p-10 space-y-6 relative min-h-screen">
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={() => router.push("/transactions")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Transactions
        </Button>
        <div className="flex items-center gap-3">
          <span className="hidden md:inline text-xs text-gray-400">Shortcuts: A approve · E edit · J/K next/prev · S save</span>
          <TallySyncBadge sync={sync} />
          {locked && !sync && (
            <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-semibold bg-sky-100 text-sky-700">
              <CheckCircle2 className="h-4 w-4" /> Exported XML
            </span>
          )}
          <Button variant="outline" onClick={downloadXml} disabled={hasUnmapped || !balanced}>
            <Download className="mr-2 h-4 w-4" /> XML
          </Button>
          <Button variant="outline" onClick={saveCurrentStep} disabled={locked || saving}>
            {savedFlash ? <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-600" /> : <Save className="mr-2 h-4 w-4" />}
            {savedFlash ? "Saved" : stage === "items" ? "Save item names" : "Save mapping"}
          </Button>
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {stage === "items" ? "Item Name Mapping" : "Ledger Mapping"}
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          {stage === "items"
            ? "Review the extracted item names first, then continue to ledger mapping."
            : "Assign ledgers, approve, then download Tally XML."}
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {inv.isDuplicate && (
        <div className="rounded-lg bg-purple-50 border border-purple-200 p-3 text-sm text-purple-800">
          Possible duplicate invoice detected (same number + vendor + amount).
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="border rounded-xl bg-white shadow-sm lg:sticky lg:top-20 self-start">
          <div className="p-4 border-b bg-gray-50/50 font-semibold">Extracted Invoice</div>
          <div className="p-4 space-y-2 text-sm">
            <Field label="Vendor" value={inv.vendor} />
            <Field label="Vendor GSTIN" value={inv.vendorGstin} />
            <Field label="Invoice No." value={inv.invoiceNumber} />
            <Field label="Date" value={inv.date ? new Date(inv.date).toLocaleDateString("en-IN") : null} />
            <Field label="Subtotal" value={inv.subtotal != null ? money(inv.subtotal) : null} />
            <Field label="CGST" value={inv.cgst != null ? money(inv.cgst) : null} />
            <Field label="SGST" value={inv.sgst != null ? money(inv.sgst) : null} />
            <Field label="IGST" value={inv.igst != null ? money(inv.igst) : null} />
            <Field label="Total" value={inv.totalAmount != null ? money(inv.totalAmount) : null} />
            {inv.irn && <Field label="IRN" value={inv.irn} />}
            {inv.ewayBillNo && <Field label="E-way Bill" value={inv.ewayBillNo} />}
          </div>
          {Array.isArray(inv.validationFlags) && inv.validationFlags.length > 0 && (
            <div className="p-4 border-t space-y-1">
              <p className="text-xs uppercase text-gray-400 mb-2">Validations</p>
              {inv.validationFlags.slice(0, 8).map((issue: any, i: number) => (
                <div
                  key={i}
                  className={`text-xs rounded px-2 py-1 ${
                    issue.severity === "error"
                      ? "bg-red-50 text-red-700"
                      : issue.severity === "warning"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-slate-50 text-slate-600"
                  }`}
                >
                  {issue.message}
                </div>
              ))}
            </div>
          )}
          {Array.isArray(inv.items) && inv.items.length > 0 && (
            <div className="p-4 border-t">
              <p className="text-xs uppercase text-gray-400 mb-2">Line items</p>
              <div className="space-y-1 text-sm max-h-48 overflow-y-auto">
                {inv.items.map((it: any, i: number) => (
                  <div key={i} className="flex justify-between gap-2">
                    <span className="truncate text-gray-700">{it.name}</span>
                    <span className="text-gray-500 shrink-0">{money(Number(it.price) || 0)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border rounded-xl bg-white shadow-sm">
          {stage === "items" ? (
            <>
              <div className="p-4 border-b bg-gray-50/50 flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <span className="font-semibold">Item Name Mapping</span>
                  <p className="text-xs text-gray-500 mt-1">
                    Choose the item name for each extracted line, then continue to ledger mapping.
                  </p>
                </div>
                <Button onClick={saveCurrentStep} disabled={saving || locked}>
                  {saving ? "Saving…" : "Save item names & continue"}
                </Button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-gray-500 bg-gray-50 uppercase text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left">Item name</th>
                      <th className="px-3 py-2 text-left">Select item name</th>
                      <th className="px-3 py-2 text-right">Debit</th>
                      <th className="px-3 py-2 text-right">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extractedItems.map((item: Record<string, any>, index: number) => {
                      const extractedName = getExtractedItemLabel(item);
                      const currentName = itemNames[index] || getItemLabel(item);
                      const amount = formatItemAmount(item);
                      return (
                        <tr key={`${extractedName}-${index}`} className="border-b align-top">
                          <td className="px-3 py-2">
                            <span className="font-medium text-gray-800">{extractedName}</span>
                          </td>
                          <td className="px-3 py-2">
                            <select
                              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none focus:border-gray-400"
                              value={currentName}
                              onChange={(e) => updateItemName(index, e.target.value)}
                              disabled={locked}
                            >
                              {itemNameOptions.map((name) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right font-medium">{amount ? money(amount) : ""}</td>
                          <td className="px-3 py-2 text-right font-medium">{item.credit ? money(Number(item.credit)) : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold bg-gray-50">
                      <td className="px-3 py-2 text-right">Total</td>
                      <td className="px-3 py-2 text-right">{money(totalDebit)}</td>
                      <td className="px-3 py-2 text-right">{money(totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="p-3 text-xs text-gray-500 border-t">
                Saved item names will be written back to the invoice before the ledger mapping step.
              </div>
            </>
          ) : (
            <>
              <div className="p-4 border-b bg-gray-50/50 flex items-center justify-between gap-2 flex-wrap">
                <span className="font-semibold">Voucher</span>
                <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs font-semibold shadow-xs">
                  {TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => changeType(t)}
                      disabled={saving || locked}
                      className={`px-3 py-1.5 transition-colors ${
                        voucherType === t
                          ? "bg-slate-900 text-white dark:bg-blue-600 dark:text-white"
                          : "bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                      }`}
                    >
                      {t.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-gray-500 bg-gray-50 uppercase text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left">Ledger</th>
                      <th className="px-3 py-2 text-right">Debit</th>
                      <th className="px-3 py-2 text-right">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let assignedUnmappedRef = false;
                      return lines.map((l, index) => {
                        const isFirstUnmapped =
                          !assignedUnmappedRef &&
                          EDITABLE_ROLES.has(l.role) &&
                          !l.ledgerId &&
                          !locked;
                        if (isFirstUnmapped) assignedUnmappedRef = true;
                        const itemLabel = l.role === "ITEM" ? itemNames[index] || getItemLabel(extractedItems[index] || {}) : null;
                        return (
                          <tr key={l.id} className="border-b align-top">
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs text-gray-400 w-14">{l.role}</span>
                                <ConfidenceChip line={l} />
                              </div>
                              {itemLabel && <div className="text-xs text-gray-500 mb-1">{itemLabel}</div>}
                              {EDITABLE_ROLES.has(l.role) && !locked ? (
                                <LedgerSelect
                                  ref={isFirstUnmapped ? firstUnmappedRef : undefined}
                                  ledgers={ledgers}
                                  value={l.ledgerId}
                                  role={l.role}
                                  onChange={(id) => setLineLedger(l.id, id)}
                                  onCreated={(led) => setLedgers((prev) => [...prev, led])}
                                />
                              ) : (
                                <span className="text-gray-800">{l.ledgerNameSnapshot || "—"}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-medium">{l.debit ? money(l.debit) : ""}</td>
                            <td className="px-3 py-2 text-right font-medium">{l.credit ? money(l.credit) : ""}</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold bg-gray-50">
                      <td className="px-3 py-2 text-right">Total</td>
                      <td className="px-3 py-2 text-right">{money(totalDebit)}</td>
                      <td className="px-3 py-2 text-right">{money(totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="p-3 text-xs text-gray-500 border-t">
                {balanced ? (
                  <span className="text-green-600">● Balanced</span>
                ) : (
                  <span className="text-red-600">● Not balanced — difference {money(Math.abs(totalDebit - totalCredit))}</span>
                )}
                {hasUnmapped && <span className="ml-3 text-red-600">● Assign all ledgers to send</span>}
              </div>
            </>
          )}
        </div>
      </div>

      {stage === "ledger" && (
        <button
          onClick={approveAndPush}
          disabled={hasUnmapped || !balanced || saving || locked || push.state.phase !== "idle"}
          className={`fixed bottom-6 left-6 md:left-[19.5rem] z-40 inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold shadow-lg transition
            ${
              locked
                ? "bg-emerald-600 text-white cursor-default"
                : hasUnmapped || !balanced
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-[#0b6b3a] text-white hover:bg-[#0a5c32] hover:shadow-xl"
            }`}
        >
          {locked ? <CheckCircle2 className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {posted ? "In Tally's books" : locked ? "Exported to Tally XML" : "Approve & Push to Tally"}
        </button>
      )}

      <TallySyncOverlay
        push={push}
        labels={{ [initial.id]: `${inv.vendor ?? "Voucher"} · ${inv.invoiceNumber ?? initial.id.slice(0, 8)}` }}
        onClose={() => void refreshSyncs()}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-slate-600 dark:text-slate-400 font-medium">{label}</span>
      <span className="text-slate-900 dark:text-slate-100 font-semibold text-right truncate">{value || "—"}</span>
    </div>
  );
}
