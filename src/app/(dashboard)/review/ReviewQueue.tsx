"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Sparkles,
} from "lucide-react";

type Row = {
  id: string;
  vendor: string;
  invoiceNumber: string;
  amount: number;
  confidence: number | null;
  hasUnmapped: boolean;
  isDuplicate: boolean;
  issueCount: number;
  balanced: boolean;
  priority: "critical" | "low" | "ready" | "high";
  voucherType: string;
};

const money = (n: number) => `₹${(n || 0).toLocaleString("en-IN")}`;

const PRIORITY_ORDER = { critical: 0, low: 1, ready: 2, high: 3 } as const;

export default function ReviewQueue({
  rows,
  highReadyCount,
}: {
  rows: Row[];
  highReadyCount: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"needs" | "all" | "high">("needs");

  const sorted = useMemo(() => {
    let list = [...rows];
    if (filter === "needs") {
      list = list.filter((r) => r.priority === "critical" || r.priority === "low");
    } else if (filter === "high") {
      list = list.filter((r) => r.priority === "high");
    }
    return list.sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        (a.confidence ?? 1) - (b.confidence ?? 1)
    );
  }, [rows, filter]);

  async function autoApproveHigh() {
    setBusy(true);
    try {
      const res = await fetch("/api/vouchers/auto-approve-high", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 0.9 }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || "Auto-approve failed", "error");
        return;
      }
      toast(
        `Auto-approved ${data.approved} high-confidence voucher(s)${
          data.skipped?.length ? ` · ${data.skipped.length} skipped` : ""
        }`,
        "success"
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 md:p-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Review queue</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Low-confidence and flagged drafts first. High-confidence mapped vouchers can auto-pass.
          </p>
        </div>
        <Button
          onClick={autoApproveHigh}
          disabled={busy || highReadyCount === 0}
          className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          Auto-approve high conf. ({highReadyCount})
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["needs", "Needs attention"],
            ["all", "All drafts"],
            ["high", "High confidence"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
              filter === id
                ? "bg-slate-900 text-white dark:bg-blue-600 dark:text-white"
                : "border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs uppercase text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 font-semibold">
            <tr>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">Invoice</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Conf.</th>
              <th className="px-4 py-3">Flags</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-slate-500 dark:text-slate-400">
                  <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-500" />
                  Queue clear for this filter.
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                <td className="px-4 py-3">
                  <PriorityChip p={r.priority} />
                </td>
                <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100">{r.vendor}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-400 font-medium">{r.invoiceNumber}</td>
                <td className="px-4 py-3 text-right font-bold text-slate-900 dark:text-slate-100">{money(r.amount)}</td>
                <td className="px-4 py-3 font-semibold">
                  {r.confidence != null ? (
                    <span
                      className={
                        r.confidence >= 0.9
                          ? "text-emerald-600 dark:text-emerald-400"
                          : r.confidence >= 0.7
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-red-600 dark:text-red-400"
                      }
                    >
                      {Math.round(r.confidence * 100)}%
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {r.hasUnmapped && (
                      <span className="rounded bg-red-50 dark:bg-red-950/50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">
                        Unmapped
                      </span>
                    )}
                    {r.isDuplicate && (
                      <span className="rounded bg-purple-50 dark:bg-purple-950/50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 dark:text-purple-300">
                        Dup
                      </span>
                    )}
                    {r.issueCount > 0 && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 dark:bg-amber-950/50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" /> {r.issueCount}
                      </span>
                    )}
                    {!r.balanced && (
                      <span className="rounded bg-orange-50 dark:bg-orange-950/50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700 dark:text-orange-300">
                        Unbalanced
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/vouchers/${r.id}`}
                    className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 font-semibold hover:underline"
                  >
                    Review <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PriorityChip({ p }: { p: Row["priority"] }) {
  const styles = {
    critical: "bg-red-100 text-red-700",
    low: "bg-orange-100 text-orange-700",
    ready: "bg-yellow-100 text-yellow-700",
    high: "bg-emerald-100 text-emerald-700",
  };
  const labels = {
    critical: "Critical",
    low: "Review",
    ready: "Ready",
    high: "Auto-pass",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${styles[p]}`}>
      {labels[p]}
    </span>
  );
}
