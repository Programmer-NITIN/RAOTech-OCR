"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Clock, Loader2, Send, CheckCircle2 } from "lucide-react";
import type { PortfolioRow } from "@/lib/portfolio";

function attentionRank(r: PortfolioRow): number {
  if (r.failedCount > 0) return 0;
  if (r.stuckCount > 0) return 1;
  if (r.unsyncedMasters > 0 && r.readyCount > 0) return 2;
  if (r.readyCount > 0) return 3;
  if (r.needsReviewCount > 0) return 4;
  return 5;
}

/**
 * One row per client, and one sentence per row saying what is wrong.
 *
 * The counts alone would make this a spreadsheet. What an owner needs is the
 * verdict — "three vouchers rejected" — with the numbers there to back it up,
 * so the decision of which client to open takes a glance rather than a
 * comparison.
 *
 * Clicking a row switches the whole app to that client, because every other
 * screen is scoped to the switcher. Landing on a client's dashboard without
 * switching would show the previous client's data under the new client's name,
 * which is the kind of wrong that gets into someone's books.
 */

const money = (n: number) => n.toLocaleString("en-IN");

function verdict(r: PortfolioRow): { text: string; tone: "bad" | "warn" | "todo" | "ok" } {
  if (r.failedCount > 0) {
    return {
      text: `${r.failedCount} voucher${r.failedCount === 1 ? "" : "s"} rejected by Tally`,
      tone: "bad",
    };
  }
  if (r.stuckCount > 0) {
    return {
      text: `${r.stuckCount} stuck sending — may or may not be in the books`,
      tone: "warn",
    };
  }
  if (r.unsyncedMasters > 0 && r.readyCount > 0) {
    return {
      text: `${r.readyCount} ready, but ${r.unsyncedMasters} master${
        r.unsyncedMasters === 1 ? "" : "s"
      } not in Tally yet`,
      tone: "warn",
    };
  }
  if (r.readyCount > 0) {
    return { text: `${r.readyCount} approved, waiting to push`, tone: "todo" };
  }
  if (r.needsReviewCount > 0) {
    return { text: `${r.needsReviewCount} need review`, tone: "todo" };
  }
  if (r.draftCount > 0) {
    return { text: `${r.draftCount} draft${r.draftCount === 1 ? "" : "s"}`, tone: "todo" };
  }
  return { text: "Nothing waiting", tone: "ok" };
}

const TONE: Record<string, { color: string; bg: string; border: string }> = {
  bad: { color: "#f87171", bg: "rgba(239,68,68,0.06)", border: "rgba(239,68,68,0.35)" },
  warn: { color: "#fbbf24", bg: "rgba(245,158,11,0.06)", border: "rgba(245,158,11,0.3)" },
  todo: { color: "var(--spx-text-secondary)", bg: "transparent", border: "var(--spx-border)" },
  ok: { color: "var(--spx-muted)", bg: "transparent", border: "var(--spx-border)" },
};

function ago(d: Date | string | null): string {
  if (!d) return "never";
  const then = new Date(d).getTime();
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d ago` : new Date(d).toISOString().slice(0, 10);
}

export default function PortfolioTable({
  rows,
  activeClientId,
}: {
  rows: PortfolioRow[];
  activeClientId: string;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState<string | null>(null);

  async function open(clientId: string) {
    if (clientId === activeClientId) return router.push("/dashboard");
    setSwitching(clientId);
    try {
      // Switch first, then navigate. The dashboard reads whichever client is
      // active server-side, so navigating first would render the old one.
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      if (res.ok) {
        router.push("/dashboard");
        router.refresh();
      } else {
        setSwitching(null);
      }
    } catch {
      setSwitching(null);
    }
  }

  const needing = rows.filter((r) => attentionRank(r) <= 2).length;

  if (!rows.length) {
    return (
      <div className="rounded-xl border border-[var(--spx-border)] bg-[var(--spx-card)] p-10 text-center">
        <p className="text-sm text-[var(--spx-muted)]">No clients yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {needing > 0 ? (
        <div
          className="flex items-start gap-2 rounded-xl p-3 text-sm"
          style={{
            border: `1px solid ${TONE.bad.border}`,
            background: TONE.bad.bg,
          }}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: TONE.bad.color }} />
          <span>
            {needing} client{needing === 1 ? " has" : "s have"} something that will not reach Tally
            on its own.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span>Nothing is stuck or rejected across any client.</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-[var(--spx-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--spx-input-bg)] text-left text-[var(--spx-muted)]">
            <tr>
              <th className="px-4 py-2.5 font-medium">Client</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Drafts</th>
              <th className="px-4 py-2.5 text-right font-medium">Ready</th>
              <th className="px-4 py-2.5 text-right font-medium">In Tally</th>
              <th className="px-4 py-2.5 font-medium">Last sync</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const v = verdict(r);
              const tone = TONE[v.tone];
              return (
                <tr
                  key={r.clientId}
                  onClick={() => void open(r.clientId)}
                  className="cursor-pointer border-t border-[var(--spx-border)] transition hover:bg-[var(--spx-card-hover)]"
                  style={{ background: v.tone === "bad" ? tone.bg : undefined }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium text-[var(--spx-text)]">
                      {r.clientName}
                      {r.clientId === activeClientId && (
                        <span className="rounded border border-[var(--spx-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--spx-muted)]">
                          current
                        </span>
                      )}
                      {switching === r.clientId && (
                        <Loader2 className="size-3.5 animate-spin text-[var(--spx-muted)]" />
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--spx-muted)]">
                      {r.tallyCompany ? (
                        r.tallyCompany
                      ) : (
                        <span style={{ color: TONE.warn.color }}>no Tally company bound</span>
                      )}
                      {r.gstin ? ` · ${r.gstin}` : ""}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
                      style={{ border: `1px solid ${tone.border}`, color: tone.color }}
                    >
                      {v.tone === "bad" && <AlertTriangle className="size-3.5" />}
                      {v.tone === "warn" && <Clock className="size-3.5" />}
                      {v.tone === "todo" && <Send className="size-3.5" />}
                      {v.text}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--spx-muted)]">
                    {r.draftCount ? money(r.draftCount) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--spx-muted)]">
                    {r.readyCount ? money(r.readyCount) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--spx-muted)]">
                    {r.postedCount ? money(r.postedCount) : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--spx-muted)]">
                    {ago(r.lastSyncedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[var(--spx-muted)]">
        Clicking a client switches the whole app to it.
      </p>
    </div>
  );
}
