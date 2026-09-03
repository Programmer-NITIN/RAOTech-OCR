"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FileText,
  Landmark,
  ArrowRight,
  CheckSquare,
  Download,
  Loader2,
  AlertTriangle,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TallySyncBadge } from "@/components/TallySyncBadge";
import { TallySyncOverlay } from "@/components/TallySyncOverlay";
import {
  useTallyPush,
  usePushPreflight,
  useVoucherSyncs,
  type PreflightResult,
} from "@/components/tallyClient";

/** Mirrors PreflightIssue in src/lib/tally/preflight.ts. */
interface ExportIssue {
  voucherId: string;
  code: string;
  severity: "error" | "warning";
  message: string;
}

interface VoucherRow {
  id: string;
  vendor: string;
  invoiceNumber: string;
  type: string;
  amount: number;
  status: string;
  hasUnmapped: boolean;
  isDuplicate?: boolean;
  confidence?: number | null;
}

interface BankRow {
  id: string;
  fileName: string;
  bankName: string | null;
  status: string;
  txnCount: number;
  unmapped: number;
  totalIn: number;
  totalOut: number;
}

const money = (n: number) =>
  `₹${(n || 0).toLocaleString("en-IN")}`;

function trace(event: string, meta?: Record<string, unknown>) {
  if (process.env.NEXT_PUBLIC_TRACE_LOGS === "0") return;

  if (meta) {
    console.log(`[trace][transactions-ui] ${event}`, meta);
    return;
  }

  console.log(`[trace][transactions-ui] ${event}`);
}

function StatusChip({
  status,
  unmapped,
  isDuplicate,
  confidence,
}: {
  status: string;
  unmapped: boolean;
  isDuplicate?: boolean;
  confidence?: number | null;
}) {
  if (isDuplicate) {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-500/15 text-purple-400 border border-purple-500/20">
        Duplicate
      </span>
    );
  }

  if (status === "EXPORTED_DEMO") {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/20">
        Exported XML
      </span>
    );
  }

  if (
    status === "SYNCED" ||
    status === "APPROVED" ||
    status === "POSTED"
  ) {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
        {status === "APPROVED" ? "Approved" : "Synced"}
      </span>
    );
  }

  if (unmapped) {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
        Needs ledger
      </span>
    );
  }

  if (confidence != null && confidence < 0.7) {
    return (
      <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-500/15 text-orange-400 border border-orange-500/20">
        Low conf.
      </span>
    );
  }

  return (
    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
      Ready
    </span>
  );
}

export default function TransactionsList({
  vouchers,
  statements,
  initialSyncFilter = null,
}: {
  vouchers: VoucherRow[];
  statements: BankRow[];
  /** Set by `?sync=failed|stuck`, so the dashboard can link into this view. */
  initialSyncFilter?: "failed" | "stuck" | null;
}) {
  const router = useRouter();

  const [tab, setTab] = useState<"invoices" | "bank">("invoices");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "ready" | "low">("all");
  const [hideSynced, setHideSynced] = useState(false);
  const [failedOnly, setFailedOnly] = useState(initialSyncFilter === "failed");
  const [stuckOnly, setStuckOnly] = useState(initialSyncFilter === "stuck");
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const { toast } = useToast();
  // Populated when the server refuses an export because Tally would reject it.
  const [blocked, setBlocked] = useState<ExportIssue[] | null>(null);

  const voucherIds = useMemo(() => vouchers.map((v) => v.id), [vouchers]);
  const { syncs, refresh: refreshSyncs } = useVoucherSyncs(voucherIds);

  // A push settling changes both the sync rows and Voucher.status, so refresh
  // the server component too rather than letting the table drift from Tally.
  const onSettled = useCallback(() => {
    void refreshSyncs();
    router.refresh();
  }, [refreshSyncs, router]);
  const push = useTallyPush({ onSettled });

  /**
   * What a push would do, worked out as the selection changes rather than
   * after the click.
   *
   * The server checks all of this anyway and answers 422 — that is the
   * authority and it stays. What it could not do is tell someone *before* they
   * committed to forty vouchers that six of them were never going to post, and
   * then leave them to find those six in a table of forty.
   */
  const { preflight, checking: preflighting } = usePushPreflight(
    useMemo(() => [...selected].sort(), [selected])
  );
  const pushBlocked = preflight ? !preflight.ready : false;

  const labels = useMemo(
    () => Object.fromEntries(vouchers.map((v) => [v.id, `${v.vendor} · ${v.invoiceNumber}`])),
    [vouchers]
  );

  const filtered = useMemo(() => {
    let rows = vouchers;
    if (filter === "ready") rows = rows.filter((v) => !v.hasUnmapped && v.status === "DRAFT");
    if (filter === "low")
      rows = rows.filter((v) => v.hasUnmapped || (v.confidence != null && v.confidence < 0.7));
    if (hideSynced)
      rows = rows.filter((v) => syncs[v.id]?.state !== "POSTED" && v.status !== "POSTED");
    if (failedOnly) rows = rows.filter((v) => syncs[v.id]?.state === "FAILED");
    // "Stuck" is SENDING and old enough that a push in flight is ruled out.
    // Matches the dashboard's ten-minute grace period.
    if (stuckOnly) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      rows = rows.filter((v) => {
        const s = syncs[v.id];
        if (s?.state !== "SENDING") return false;
        const at = s.lastAttemptAt ? new Date(s.lastAttemptAt).getTime() : 0;
        return at < cutoff;
      });
    }
    return rows;
  }, [vouchers, filter, hideSynced, failedOnly, stuckOnly, syncs]);

  /** Only a voucher Tally has actually accepted can be removed from its books. */
  const deletable = useMemo(
    () => [...selected].filter((id) => syncs[id]?.state === "POSTED"),
    [selected, syncs]
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function toggleAllReady() {
    const ready = filtered
      .filter(
        (v) => !v.hasUnmapped && v.status === "DRAFT"
      )
      .map((v) => v.id);

    setSelected(new Set(ready));
  }

  async function bulkApprove() {
    if (!selected.size) return;

    const startedAt = performance.now();

    trace("bulk-approve:start", {
      selectedCount: selected.size,
    });

    setBusy(true);

    try {
      await fetch("/api/vouchers/bulk-approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          voucherIds: [...selected],
        }),
      });

      trace("bulk-approve:done", {
        selectedCount: selected.size,
        durationMs: Number(
          (performance.now() - startedAt).toFixed(2)
        ),
      });

      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function exportTally(ids?: string[]) {
    const startedAt = performance.now();

    trace("export-tally:start", {
      selectedCount: ids?.length ?? 0,
    });

    setBusy(true);
    setBlocked(null);
    try {
      const res = await fetch("/api/export/tally", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          ids?.length ? { voucherIds: ids } : {}
        ),
      });

      // 422 means preflight caught something Tally would reject. Show exactly
      // what and on which voucher, rather than a generic failure — the whole
      // point is to save the user a trip through Tally.imp.
      if (res.status === 422) {
        const body = await res.json().catch(() => ({}));
        const issues: ExportIssue[] = [
          ...(body.issues ?? []),
          ...(body.warnings ?? []),
        ];
        setBlocked(issues.length ? issues : [
          { voucherId: "", code: "UNKNOWN", severity: "error", message: body.error || "Export blocked." },
        ]);
        return;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || "Export failed", "error");
        return;
      }

      const warnings = Number(res.headers.get("X-Export-Warnings") || 0);
      const count = Number(res.headers.get("X-Export-Count") || 0);
      const blob = await res.blob();

      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `tally_export_${new Date()
        .toISOString()
        .slice(0, 10)}.xml`;

      a.click();

      URL.revokeObjectURL(url);
      toast(
        warnings
          ? `Exported ${count} voucher(s) with ${warnings} warning(s) — check ledger names in Tally.`
          : `Exported ${count} voucher(s). Import the file in Tally.`,
        warnings ? "info" : "success"
      );

      trace("export-tally:done", {
        selectedCount: ids?.length ?? 0,
        durationMs: Number(
          (performance.now() - startedAt).toFixed(2)
        ),
      });

      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full bg-[var(--spx-canvas)] text-[var(--spx-text)] p-6 md:p-10 space-y-6">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--spx-text)]">
            Transactions
          </h1>

          <p className="text-[var(--spx-muted)] text-sm mt-1">
            Map ledgers, approve, and export Tally XML
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={toggleAllReady}
            className="bg-[var(--spx-input-bg)] border-[var(--spx-border)] text-[var(--spx-text-secondary)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]"
          >
            <CheckSquare className="mr-2 h-4 w-4" />
            Select ready
          </Button>

          <Button
            size="sm"
            disabled={!selected.size || busy}
            onClick={bulkApprove}
            className="bg-white text-black hover:bg-zinc-200"
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}

            Approve selected ({selected.size})
          </Button>

          {deletable.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmDelete(deletable)}
              className="border-red-500/30 bg-[var(--spx-input-bg)] text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete From Tally ({deletable.length})
            </Button>
          )}
          {/* Export XML and Push to Tally now route to the pricing page. */}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => router.push("/pricing")}
            className="bg-green-600 hover:bg-green-500 text-white"
          >
            <Download className="mr-2 h-4 w-4" />
            Export XML
          </Button>
          <Button
            size="sm"
            className="bg-[#0b6b3a] hover:bg-[#0a5c32]"
            onClick={() => router.push("/pricing")}
          >
            <Send className="mr-2 h-4 w-4" />
            Push to Tally ({selected.size})
          </Button>
        </div>
      </div>

      {selected.size > 0 && (
        <PreflightPanel result={preflight} checking={preflighting} />
      )}

      {blocked && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-300 dark:bg-red-950/30">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
              <div>
                <h3 className="font-semibold text-red-200">
                  Tally would reject this export
                </h3>
                <p className="mt-0.5 text-sm text-red-300/80">
                  Fixed here, these never become an error buried in Tally.imp. Errors block
                  the export; warnings do not.
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setBlocked(null)}
              className="rounded p-1 text-red-400 hover:bg-red-500/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <ul className="mt-3 space-y-2">
            {blocked.map((issue, i) => {
              const v = vouchers.find((row) => row.id === issue.voucherId);
              return (
                <li
                  key={`${issue.voucherId}-${issue.code}-${i}`}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-[var(--spx-border)] bg-[var(--spx-card)] px-3 py-2 text-sm text-[var(--spx-text)]"
                >
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                      issue.severity === "error"
                        ? "bg-red-500/20 text-red-400 border border-red-500/30"
                        : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                    }`}
                  >
                    {issue.severity}
                  </span>
                  {v ? (
                    <Link
                      href={`/vouchers/${v.id}`}
                      className="font-medium text-emerald-400 hover:underline"
                    >
                      {v.vendor} · {v.invoiceNumber}
                    </Link>
                  ) : (
                    issue.voucherId && (
                      <span className="font-medium text-[var(--spx-muted)]">
                        {issue.voucherId.slice(0, 8)}
                      </span>
                    )
                  )}
                  <span className="text-[var(--spx-muted)]">{issue.message}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => {
            trace("tab:change", {
              from: tab,
              to: "invoices",
            });

            setTab("invoices");
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
            tab === "invoices"
              ? "bg-zinc-900 text-zinc-100 border-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100"
              : "bg-[var(--spx-input-bg)] text-[var(--spx-muted)] border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]"
          }`}
        >
          Invoices ({vouchers.length})
        </button>

        <button
          onClick={() => {
            trace("tab:change", {
              from: tab,
              to: "bank",
            });

            setTab("bank");
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
            tab === "bank"
              ? "bg-zinc-900 text-zinc-100 border-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100"
              : "bg-[var(--spx-input-bg)] text-[var(--spx-muted)] border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]"
          }`}
        >
          Bank Statements ({statements.length})
        </button>

        {tab === "invoices" && (
          <>
            {(["all", "ready", "low"] as const).map((f) => (
              <button
                key={f}
                onClick={() => {
                  trace("filter:change", {
                    from: filter,
                    to: f,
                  });

                  setFilter(f);
                }}
                className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${
                  filter === f
                    ? "bg-zinc-800 text-zinc-100 border-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:border-zinc-300 font-semibold"
                    : "bg-[var(--spx-input-bg)] text-[var(--spx-muted)] border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]"
                }`}
              >
                {f === "all"
                  ? "All"
                  : f === "ready"
                  ? "Ready"
                  : "Needs attention"}
              </button>
            ))}
            <button
              onClick={() => setHideSynced((v) => !v)}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${
                hideSynced
                  ? "bg-emerald-600 text-white border-emerald-500"
                  : "bg-[var(--spx-input-bg)] text-[var(--spx-muted)] border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]"
              }`}
            >
              Hide Tally Synced
            </button>
            <button
              onClick={() => {
                setFailedOnly((v) => !v);
                setStuckOnly(false);
              }}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${
                failedOnly
                  ? "bg-red-600 text-white border-red-500"
                  : "bg-[var(--spx-input-bg)] text-[var(--spx-muted)] border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]"
              }`}
            >
              Failed Records Only
            </button>
            <button
              onClick={() => {
                setStuckOnly((v) => !v);
                setFailedOnly(false);
              }}
              title="Sent to a connector more than ten minutes ago with no result reported back"
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${
                stuckOnly
                  ? "bg-amber-500 text-white border-amber-400"
                  : "bg-[var(--spx-input-bg)] text-[var(--spx-muted)] border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)] hover:text-[var(--spx-text)]"
              }`}
            >
              Stuck Sending
            </button>
          </>
        )}
      </div>

      {/* Invoices */}
      {tab === "invoices" ? (
        <div className="border border-[var(--spx-border)] rounded-xl bg-[var(--spx-card)] shadow-xl overflow-hidden">

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">

              <thead className="text-[var(--spx-muted)] bg-[var(--spx-input-bg)] uppercase text-xs border-b border-[var(--spx-border)]">
                <tr>
                  <th className="px-4 py-3 w-10"></th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Invoice #</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">
                    Amount
                  </th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Tally</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>

              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-12 text-center text-zinc-600"
                    >
                      {failedOnly || stuckOnly || hideSynced
                        ? "No rows match these filters."
                        : "No invoices yet. Upload to create vouchers."}
                    </td>
                  </tr>
                )}

                {filtered.map((v) => (
                  <tr
                    key={v.id}
                    className="border-b border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)]/70 transition group"
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(v.id)}
                        onChange={() => toggle(v.id)}
                        disabled={
                          v.status !== "DRAFT" &&
                          v.status !== "APPROVED"
                        }
                        className="rounded border-zinc-700 bg-zinc-900"
                      />
                    </td>

                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/vouchers/${v.id}`}
                        className="flex items-center gap-2 text-[var(--spx-text)] group-hover:text-[var(--spx-text)]"
                      >
                        <FileText className="h-4 w-4 text-[var(--spx-muted)]" />
                        {v.vendor}
                      </Link>
                    </td>

                    <td className="px-4 py-3 text-[var(--spx-muted)]">
                      {v.invoiceNumber}
                    </td>

                    <td className="px-4 py-3 text-[var(--spx-muted)]">
                      {v.type}
                    </td>

                    <td className="px-4 py-3 text-right font-semibold text-[var(--spx-text)]">
                      {money(v.amount)}
                    </td>

                    <td className="px-4 py-3">
                      <StatusChip
                        status={v.status}
                        unmapped={v.hasUnmapped}
                        isDuplicate={v.isDuplicate}
                        confidence={v.confidence}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <TallySyncBadge sync={syncs[v.id]} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/vouchers/${v.id}`}
                        className="inline-flex items-center gap-1 text-[var(--spx-muted)] hover:text-[var(--spx-text)]"
                      >
                        Map
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>

            </table>
          </div>
        </div>

      ) : (

        /* Bank Statements */
        <div className="border border-[var(--spx-border)] rounded-xl bg-[var(--spx-card)] shadow-xl overflow-hidden">

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">

              <thead className="text-[var(--spx-muted)] bg-[var(--spx-input-bg)] uppercase text-xs border-b border-[var(--spx-border)]">
                <tr>
                  <th className="px-4 py-3">Bank</th>
                  <th className="px-4 py-3">File</th>
                  <th className="px-4 py-3 text-center">
                    Txns
                  </th>
                  <th className="px-4 py-3 text-right">
                    In / Out
                  </th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>

              <tbody>
                {statements.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-12 text-center text-zinc-600"
                    >
                      No bank statements yet. Upload one from
                      the Upload page.
                    </td>
                  </tr>
                )}

                {statements.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-[var(--spx-border)] hover:bg-[var(--spx-card-hover)]/70 transition group"
                  >
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={`/bank/${s.id}`}
                        className="flex items-center gap-2 text-[var(--spx-text)] hover:text-[var(--spx-text)]"
                      >
                        <Landmark className="h-4 w-4 text-[var(--spx-muted)]" />
                        {s.bankName || "Bank Statement"}
                      </Link>
                    </td>

                    <td className="px-4 py-3 text-[var(--spx-muted)] truncate max-w-[160px]">
                      {s.fileName}
                    </td>

                    <td className="px-4 py-3 text-center text-[var(--spx-muted)]">
                      {s.txnCount}
                    </td>

                    <td className="px-4 py-3 text-right text-[var(--spx-muted)] whitespace-nowrap">
                      <span className="text-emerald-400">
                        {money(s.totalIn)}
                      </span>{" "}
                      /{" "}
                      <span className="text-red-400">
                        {money(s.totalOut)}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <StatusChip
                        status={s.status}
                        unmapped={s.unmapped > 0}
                      />
                    </td>

                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/bank/${s.id}`}
                        className="inline-flex items-center gap-1 text-[var(--spx-muted)] hover:text-[var(--spx-text)]"
                      >
                        Map
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>

            </table>
          </div>
        </div>
      )}

      <TallySyncOverlay
        push={push}
        labels={labels}
        onClose={() => {
          setSelected(new Set());
          void refreshSyncs();
        }}
      />

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.length} voucher${confirmDelete.length === 1 ? "" : "s"} from Tally?`}
          body={
            <>
              This removes {confirmDelete.length === 1 ? "the voucher" : "these vouchers"} from
              Tally&apos;s books on the connected machine — not just from this workspace. Tally
              resolves the deletion by the id we posted with, so it removes exactly what we sent.
              It cannot be undone from here; the voucher would have to be pushed again.
            </>
          }
          confirmLabel="Delete from Tally"
          onConfirm={() => {
            const ids = confirmDelete;
            setConfirmDelete(null);
            void push.remove(ids);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/**
 * The verdict on the current selection, above the button that acts on it.
 *
 * Deliberately one sentence first and detail second. An accountant selecting
 * rows wants to know whether to press the button, not to read a report; the
 * per-voucher reasons matter only once the answer is "no", so they open rather
 * than fill the screen.
 *
 * Nothing here is authoritative — the push route runs the same checks and
 * answers 422 regardless. This is a courtesy, and it fails open: if the check
 * cannot run, the button stays enabled and the server does its job.
 */
function PreflightPanel({
  result,
  checking,
}: {
  result: PreflightResult | null;
  checking: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (checking && !result) {
    return (
      <div className="flex items-center gap-2 rounded-xl border p-3 text-sm text-gray-500">
        <Loader2 className="size-4 animate-spin" /> Checking what Tally would say…
      </div>
    );
  }
  if (!result) return null;

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  // Ordered by what stops the push, then by what makes it silently do nothing,
  // then by what is merely worth knowing.
  const tone = !result.ready
    ? "bad"
    : result.connector && !result.connector.online
      ? "warn"
      : warnings.length || result.mastersToCreate
        ? "info"
        : "ok";

  const box = {
    bad: "border-red-500/30 bg-red-500/10 text-red-300 dark:bg-red-950/30",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300 dark:bg-amber-950/30",
    info: "border-sky-500/30 bg-sky-500/10 text-sky-300 dark:bg-sky-950/30",
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 dark:bg-emerald-950/30",
  }[tone];

  const headline = !result.ready
    ? (result.reason ??
      `${result.blockingCount} of ${result.voucherCount} would be rejected by Tally.`)
    : result.connector && !result.connector.online
      ? "Nothing is listening. These will queue and sit until the connector runs."
      : `${result.voucherCount} ready to post to ${result.companyName ?? "Tally"}.`;

  return (
    <div className={`rounded-xl border p-3 text-sm ${box}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {tone === "bad" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-400" />
          ) : tone === "ok" ? (
            <CheckSquare className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          )}
          <div>
            <p className="font-medium text-[var(--spx-text)]">{headline}</p>

            <ul className="mt-1 space-y-0.5 text-xs text-[var(--spx-muted)]">
              {result.notPushable ? (
                <li>
                  {result.notPushable} of the rows you picked are not approved and were left out.
                </li>
              ) : null}
              {result.mastersToCreate ? (
                <li>
                  {result.mastersToCreate} master
                  {result.mastersToCreate === 1 ? "" : "s"} will be created in Tally first.
                </li>
              ) : null}
              {result.movesStock ? (
                <li>
                  Some of these move stock. That needs the company to have inventory and invoicing
                  switched on, or Tally rejects them without saying why.
                </li>
              ) : null}
              {result.educationMode ? (
                <li>
                  Tally is in education mode — it only accepts the 1st, 2nd and last day of a
                  month.
                </li>
              ) : null}
              {result.connector && !result.connector.online && result.connector.name ? (
                <li>
                  Last heard from {result.connector.name}{" "}
                  {result.connector.lastSeenAt
                    ? new Date(result.connector.lastSeenAt).toLocaleString()
                    : "never"}
                  .
                </li>
              ) : null}
              {result.connector?.online && result.connector.tallyReachable === false ? (
                <li>
                  The connector is running but cannot reach Tally
                  {result.connector.tallyMessage ? `: ${result.connector.tallyMessage}` : "."}
                </li>
              ) : null}
              {warnings.length && result.ready ? (
                <li>
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"} — these still post.
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {result.fix && (
            <Link href={result.fix.href} className="text-xs font-medium underline text-emerald-400">
              {result.fix.label}
            </Link>
          )}
          {result.issues.length > 0 && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-xs font-medium text-[var(--spx-muted)] hover:text-[var(--spx-text)] underline"
            >
              {open ? "Hide" : `Show ${result.issues.length}`}
            </button>
          )}
        </div>
      </div>

      {open && (
        <ul className="mt-3 space-y-1 border-t pt-3 text-xs">
          {[...errors, ...warnings].slice(0, 40).map((i, n) => (
            <li key={n} className={i.severity === "error" ? "text-red-700" : "text-amber-700"}>
              {i.message}
            </li>
          ))}
          {result.issues.length > 40 && (
            <li className="text-gray-500">…and {result.issues.length - 40} more.</li>
          )}
        </ul>
      )}
    </div>
  );
}
