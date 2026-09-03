"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { postMasters, type MasterPreviewResponse } from "@/components/sheetsClient";

/**
 * Bulk master upload — a chart of accounts or an item list.
 *
 * Deliberately not folded into the five-step invoice wizard. That wizard's
 * middle three steps are entirely about tax: which columns hold taxable value,
 * whether GST is wide or long, which duty ledger each rate posts to. A master
 * sheet has none of that, and walking someone through three empty steps to
 * upload a list of ledger names would be worse than useless — it would suggest
 * they had forgotten to fill something in.
 *
 * So this is two steps: name the columns, look at what would be created. The
 * preview is not optional and not skippable, because this writes to the chart
 * of accounts that every voucher in the workspace resolves against.
 */

const LEDGER_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "name", label: "Ledger name", hint: "required" },
  { key: "group", label: "Under (group)", hint: "e.g. Sundry Creditors" },
  { key: "gstin", label: "GSTIN" },
  { key: "openingBalance", label: "Opening balance" },
];

const ITEM_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "name", label: "Item name", hint: "required" },
  { key: "unit", label: "Unit", hint: "required — Tally cannot change it later" },
  { key: "hsnCode", label: "HSN / SAC" },
  { key: "gstRate", label: "GST rate %" },
  { key: "alias", label: "Alias" },
  { key: "openingQty", label: "Opening qty" },
  { key: "openingRate", label: "Opening rate" },
];

interface Props {
  uploadId: string;
  kind: "LEDGER_MASTER" | "ITEM_MASTER";
  headers: string[];
  initialMapping: Record<string, number | null> | null;
  onDone: (created: number) => void;
}

export default function MasterPanel({
  uploadId,
  kind,
  headers,
  initialMapping,
  onDone,
}: Props) {
  const fields = kind === "LEDGER_MASTER" ? LEDGER_FIELDS : ITEM_FIELDS;

  const [mapping, setMapping] = useState<Record<string, number | null>>(
    initialMapping ?? {}
  );
  const [preview, setPreview] = useState<MasterPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MasterPreviewResponse | null>(null);

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const res = await postMasters(uploadId, { mapping, dryRun });
        if (dryRun) setPreview(res);
        else {
          setDone(res);
          onDone(res.created ?? 0);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read that sheet");
      } finally {
        setBusy(false);
      }
    },
    [uploadId, mapping, onDone]
  );

  // Preview immediately on arrival. The server has already guessed the columns,
  // so landing on an empty screen and making the user press a button to see
  // their own data would be a step for its own sake.
  useEffect(() => {
    void run(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (done) {
    return (
      <section className="space-y-4 rounded-lg border p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" />
          <div>
            <h2 className="font-semibold">
              {done.created} {kind === "LEDGER_MASTER" ? "ledger" : "stock item"}
              {done.created === 1 ? "" : "s"} created
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{done.message}</p>
            {done.skipped > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">
                {done.skipped} row{done.skipped === 1 ? " was" : "s were"} already here and left
                untouched — an existing master is never overwritten by a re-upload.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  const errorIssues = preview?.issues.filter((i) => i.severity === "error") ?? [];
  const warnIssues = preview?.issues.filter((i) => i.severity === "warning") ?? [];

  return (
    <section className="space-y-6 rounded-lg border p-6">
      <div>
        <h2 className="font-semibold">
          {kind === "LEDGER_MASTER" ? "Ledgers" : "Stock items"} — name the columns
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {kind === "LEDGER_MASTER"
            ? "A group we do not recognise lands under Current Assets and is flagged, rather than becoming a posting default by accident."
            : "An item with no unit is refused, not defaulted: Tally cannot change an item's base unit once stock has moved against it."}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key}>
            <Label htmlFor={`m-${f.key}`}>
              {f.label}
              {f.hint && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">{f.hint}</span>
              )}
            </Label>
            <select
              id={`m-${f.key}`}
              className="mt-1.5 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
              value={mapping[f.key] ?? ""}
              onChange={(e) =>
                setMapping((m) => ({
                  ...m,
                  [f.key]: e.target.value === "" ? null : Number(e.target.value),
                }))
              }
            >
              <option value="" className="bg-card text-muted-foreground">— not in this sheet —</option>
              {headers.map((h, i) => (
                <option key={i} value={i} className="bg-card text-foreground">
                  {String(h || `Column ${i + 1}`)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <Button variant="outline" onClick={() => run(true)} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        Check the sheet
      </Button>

      {preview && (
        <div className="space-y-4 border-t pt-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Rows", preview.totalRows],
              ["Will create", preview.wouldCreate],
              ["Already here", preview.skipped],
              ["Blocked", preview.blocked],
            ].map(([label, n]) => (
              <div key={String(label)} className="rounded-md border p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {label}
                </div>
                <div className="text-xl font-semibold">{String(n)}</div>
              </div>
            ))}
          </div>

          {errorIssues.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <h3 className="text-sm font-semibold">
                {errorIssues.length} row{errorIssues.length === 1 ? "" : "s"} cannot be created
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {errorIssues.slice(0, 10).map((i, n) => (
                  <li key={n}>
                    <span className="text-muted-foreground">Row {i.row + 1}:</span> {i.message}
                  </li>
                ))}
              </ul>
              {errorIssues.length > 10 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  …and {errorIssues.length - 10} more.
                </p>
              )}
            </div>
          )}

          {warnIssues.length > 0 && (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {warnIssues.length} warning{warnIssues.length === 1 ? "" : "s"} — these still
                create
              </summary>
              <ul className="mt-2 space-y-1 text-sm">
                {warnIssues.slice(0, 20).map((i, n) => (
                  <li key={n}>
                    <span className="text-muted-foreground">Row {i.row + 1}:</span> {i.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  {fields
                    .filter((f) => mapping[f.key] != null)
                    .map((f) => (
                      <th key={f.key} className="px-3 py-2 font-medium">
                        {f.label}
                      </th>
                    ))}
                  {kind === "LEDGER_MASTER" && (
                    <th className="px-3 py-2 font-medium">Resolved group</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {preview.preview.slice(0, 25).map((r) => {
                  const bad = r.issues.some((i) => i.severity === "error");
                  return (
                    <tr key={r.row} className={bad ? "bg-destructive/5" : undefined}>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.row + 1}</td>
                      {fields
                        .filter((f) => mapping[f.key] != null)
                        .map((f) => (
                          <td key={f.key} className="px-3 py-1.5">
                            {r.draft ? String(r.draft[f.key] ?? "") : ""}
                          </td>
                        ))}
                      {kind === "LEDGER_MASTER" && (
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {r.draft ? String(r.draft.group ?? "") : ""}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => run(false)} disabled={busy || preview.wouldCreate === 0}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Create {preview.wouldCreate}{" "}
              {kind === "LEDGER_MASTER" ? "ledger" : "stock item"}
              {preview.wouldCreate === 1 ? "" : "s"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Created here, pushed to Tally on the next sync — there is one path to Tally, not
              two.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
