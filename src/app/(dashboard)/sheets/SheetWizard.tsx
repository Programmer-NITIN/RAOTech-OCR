"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Save,
  Sparkles,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DOC_TYPE_LABELS,
  FIELD_ORDER,
  isMasterDocType,
  commitUpload,
  previewMapping,
  saveTemplate,
  uploadSheet,
  type MappingResponse,
  type UploadResponse,
} from "@/components/sheetsClient";
import type {
  ExcelDocType,
  ItemMode,
  SheetMapping,
} from "@/lib/excel/types";
import { LAYOUT_CONFIDENCE_FLOOR } from "@/lib/excel/types";
import MasterPanel from "./MasterPanel";

/**
 * Spreadsheet → vouchers, in four steps.
 *
 * The competitor's equivalent asks the accountant to declare the sheet's shape
 * up front and then reshape the spreadsheet by hand when it does not fit — 26
 * of their 158 help articles are the same mapping feature re-explained for a
 * different layout. Here the layout is detected, the columns are pre-mapped,
 * and every guess is shown with its reasoning so it can be overridden rather
 * than fought.
 *
 * Nothing is written until Commit. Once committed, rows become ordinary draft
 * vouchers and leave this screen entirely — review, approval and the push to
 * Tally are all the existing pipeline.
 */

type Step = "upload" | "fields" | "gst" | "ledgers" | "review" | "masters";

const STEPS: { id: Step; label: string }[] = [
  { id: "upload", label: "File" },
  { id: "fields", label: "Columns" },
  { id: "gst", label: "GST" },
  { id: "ledgers", label: "Ledgers" },
  { id: "review", label: "Review" },
];

/**
 * A master sheet has two steps, not five.
 *
 * The middle three are entirely about tax — which columns hold taxable value,
 * wide or long GST, which duty ledger each rate posts to — and a chart of
 * accounts has none of it. Walking someone through three empty steps would
 * read as "you forgot to fill something in".
 */
const MASTER_STEPS: { id: Step; label: string }[] = [
  { id: "upload", label: "File" },
  { id: "masters", label: "Columns & review" },
];

interface LedgerOption {
  id: string;
  name: string;
  group: string;
}

export default function SheetWizard({
  clientName,
  ledgers,
}: {
  clientName: string;
  ledgers: LedgerOption[];
}) {
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [docType, setDocType] = useState<ExcelDocType>("PURCHASE");
  const [itemMode, setItemMode] = useState<ItemMode>("WITHOUT_ITEM");
  const [file, setFile] = useState<File | null>(null);

  const [uploaded, setUploaded] = useState<UploadResponse | null>(null);
  const [mapping, setMapping] = useState<SheetMapping | null>(null);
  const [preview, setPreview] = useState<MappingResponse | null>(null);

  const [templateName, setTemplateName] = useState("");
  const [committed, setCommitted] = useState<{ count: number } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const headers = uploaded?.headers ?? [];
  const isMaster = isMasterDocType(docType);
  const visibleSteps = isMaster ? MASTER_STEPS : STEPS;

  const doUpload = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await uploadSheet(file, docType, itemMode);
      setUploaded(res);
      // A master sheet skips straight to its own panel: there is no invoice
      // mapping to hold, and the server did not compute one.
      if (isMasterDocType(docType)) {
        setStep("masters");
      } else {
        setMapping(res.suggestedMapping);
        setStep("fields");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }, [file, docType, itemMode]);

  const doPreview = useCallback(
    async (next: Step) => {
      if (!uploaded || !mapping) return;
      setBusy(true);
      setError(null);
      try {
        const res = await previewMapping(uploaded.upload.id, mapping);
        setPreview(res);
        setStep(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not apply that mapping");
      } finally {
        setBusy(false);
      }
    },
    [uploaded, mapping]
  );

  const doCommit = useCallback(async () => {
    if (!uploaded) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const res = await commitUpload(uploaded.upload.id, (done, left) =>
        setProgress(`${done} created${left ? `, ${left} to go` : ""}…`)
      );
      setCommitted({ count: res.committed });
      if (templateName.trim()) {
        await saveTemplate({
          name: templateName.trim(),
          headers,
          mapping: mapping!,
          uploadId: uploaded.upload.id,
        }).catch(() => null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [uploaded, templateName, headers, mapping]);

  const setField = (key: keyof SheetMapping["fields"], value: number | null) =>
    setMapping((m) => (m ? { ...m, fields: { ...m.fields, [key]: value } } : m));

  const setGst = (patch: Partial<SheetMapping["gst"]>) =>
    setMapping((m) => (m ? { ...m, gst: { ...m.gst, ...patch } } : m));

  const setLedger = (key: keyof SheetMapping["ledgers"], value: string | null) =>
    setMapping((m) => (m ? { ...m, ledgers: { ...m.ledgers, [key]: value } } : m));

  const requiredMissing = useMemo(() => {
    if (!mapping) return [];
    return FIELD_ORDER.filter((f) => {
      const req =
        f.required === true ||
        (f.required === "WITH_ITEM" && mapping.itemMode === "WITH_ITEM") ||
        (f.required === "JOURNAL" && mapping.docType === "JOURNAL");
      return req && mapping.fields[f.key] === null;
    }).map((f) => f.label);
  }, [mapping]);

  if (committed) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <CheckCircle2 className="mx-auto mb-4 size-12 text-emerald-500" />
        <h1 className="text-2xl font-semibold">
          {committed.count} draft voucher{committed.count === 1 ? "" : "s"} created
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          They are ordinary vouchers now — review and approve them, then push to Tally.
          Nothing has reached your books yet.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/transactions">
            <Button>Go to Transactions</Button>
          </Link>
          <Button
            variant="outline"
            onClick={() => {
              setCommitted(null);
              setUploaded(null);
              setMapping(null);
              setPreview(null);
              setFile(null);
              setStep("upload");
            }}
          >
            Upload another sheet
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileSpreadsheet className="size-4" />
          <span>Sheet upload</span>
          <span>·</span>
          <span>{clientName}</span>
        </div>
        <h1 className="mt-1 text-2xl font-semibold">Import a spreadsheet</h1>
      </header>

      <ol className="mb-8 flex flex-wrap gap-2 text-sm">
        {visibleSteps.map((s, i) => {
          const active = s.id === step;
          const done = visibleSteps.findIndex((x) => x.id === step) > i;
          return (
            <li
              key={s.id}
              className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-all shadow-xs ${
                active
                  ? "border-primary bg-primary text-primary-foreground font-semibold shadow-sm"
                  : done
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-border bg-card/80 text-muted-foreground hover:bg-card hover:text-foreground"
              }`}
            >
              {i + 1}. {s.label}
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}

      {step === "upload" && (
        <section className="space-y-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="docType">Document type</Label>
              <select
                id="docType"
                className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-xs transition-all outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                value={docType}
                onChange={(e) => setDocType(e.target.value as ExcelDocType)}
              >
                {Object.entries(DOC_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v} className="bg-card text-foreground">
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className={isMaster ? "hidden" : undefined}>
              <Label htmlFor="itemMode">Does the sheet have item detail?</Label>
              <select
                id="itemMode"
                className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-xs transition-all outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                value={itemMode}
                onChange={(e) => setItemMode(e.target.value as ItemMode)}
              >
                <option value="WITHOUT_ITEM" className="bg-card text-foreground">No — one row per bill</option>
                <option value="WITH_ITEM" className="bg-card text-foreground">Yes — one row per line item</option>
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                With item detail, several rows sharing an invoice number become one voucher.
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="file">Spreadsheet</Label>
            <Input
              id="file"
              type="file"
              accept=".xlsx,.csv"
              className="mt-1.5"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              .xlsx or .csv. Headers can be anywhere near the top — we find them. Grand-total
              rows are detected and skipped, so there is no need to tidy the sheet first.
            </p>
          </div>

          <Button onClick={doUpload} disabled={!file || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Read the sheet
          </Button>
        </section>
      )}

      {step !== "upload" && uploaded && mapping && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <Stat label="Rows found" value={String(uploaded.totalRows)} />
            <Stat
              label="Header row"
              value={`Row ${uploaded.headerRowIndex + 1}`}
              hint={uploaded.droppedRows ? `${uploaded.droppedRows} summary rows skipped` : undefined}
            />
            {/* Absent on a master sheet: layout detection is about GST columns,
                and a chart of accounts has none. */}
            {uploaded.layout && (
              <Stat
                label="Tax layout"
                value={
                  uploaded.layout.taxLayout === "WIDE" ? "Column per rate" : "Fixed tax columns"
                }
                hint={uploaded.layout.reason}
                warn={uploaded.layout.confidence < LAYOUT_CONFIDENCE_FLOOR}
              />
            )}
          </div>

          {uploaded.templates.length > 0 && (
            <div className="mb-6 flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-sky-500" />
              <div>
                <p className="font-medium">
                  Recognised this layout — {uploaded.templates[0].name}
                </p>
                <p className="text-muted-foreground">
                  Used {uploaded.templates[0].hitCount} time
                  {uploaded.templates[0].hitCount === 1 ? "" : "s"} before. The columns below are
                  already filled in from it.
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {step === "masters" && uploaded && (
        <MasterPanel
          uploadId={uploaded.upload.id}
          kind={docType as "LEDGER_MASTER" | "ITEM_MASTER"}
          headers={headers}
          initialMapping={uploaded.masterMapping ?? null}
          onDone={(count) => setCommitted({ count })}
        />
      )}

      {step === "fields" && mapping && (
        <section className="space-y-4 rounded-lg border p-6">
          <h2 className="font-medium">Which column holds what?</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELD_ORDER.filter((f) => {
              if (f.required === "WITH_ITEM") return mapping.itemMode === "WITH_ITEM";
              if (f.required === "JOURNAL") return mapping.docType === "JOURNAL";
              return mapping.docType !== "JOURNAL";
            }).map((f) => {
              const required =
                f.required === true ||
                (f.required === "WITH_ITEM" && mapping.itemMode === "WITH_ITEM") ||
                (f.required === "JOURNAL" && mapping.docType === "JOURNAL");
              const value = mapping.fields[f.key];
              return (
                <div key={f.key}>
                  <Label className="text-xs">
                    {f.label}
                    {required && <span className="ml-1 text-destructive">*</span>}
                  </Label>
                  <select
                    className={`mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground ${
                      required && value === null ? "border-amber-500/60" : ""
                    }`}
                    value={value ?? ""}
                    onChange={(e) =>
                      setField(f.key, e.target.value === "" ? null : Number(e.target.value))
                    }
                  >
                    <option value="" className="bg-card text-muted-foreground">— not in this sheet —</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i} className="bg-card text-foreground">
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          {requiredMissing.length > 0 && (
            <p className="text-sm text-amber-600">
              Still needed: {requiredMissing.join(", ")}
            </p>
          )}

          <Nav
            onBack={() => setStep("upload")}
            onNext={() => setStep("gst")}
            nextDisabled={requiredMissing.length > 0}
          />
        </section>
      )}

      {step === "gst" && mapping && (
        <section className="space-y-4 rounded-lg border p-6">
          <h2 className="font-medium">Where does GST come from?</h2>

          <div className="flex gap-3">
            {(["FROM_SHEET", "CALCULATE"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setGst({ source: s })}
                className={`rounded-md border px-4 py-2 text-sm ${
                  mapping.gst.source === s
                    ? "border-foreground/40 bg-foreground/5 font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {s === "FROM_SHEET" ? "Tax amounts are in the sheet" : "Calculate from a rate"}
              </button>
            ))}
          </div>

          {mapping.gst.taxLayout === "WIDE" ? (
            <div className="rounded-md border p-4">
              <p className="text-sm font-medium">
                {mapping.gst.rateGroups.length} rate groups detected
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Each becomes its own line at that rate. No need to pick a primary rate or
                reshape the sheet.
              </p>
              <ul className="mt-3 space-y-1 text-sm">
                {mapping.gst.rateGroups.map((g) => (
                  <li key={g.rate} className="text-muted-foreground">
                    <span className="font-medium text-foreground">{g.rate}%</span> — taxable{" "}
                    {g.taxable !== null ? headers[g.taxable] : "—"}, CGST{" "}
                    {g.cgst !== null ? headers[g.cgst] : "—"}, SGST{" "}
                    {g.sgst !== null ? headers[g.sgst] : "—"}, IGST{" "}
                    {g.igst !== null ? headers[g.igst] : "—"}
                  </li>
                ))}
              </ul>
            </div>
          ) : mapping.gst.source === "FROM_SHEET" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {(["cgst", "sgst", "igst"] as const).map((k) => (
                <div key={k}>
                  <Label className="text-xs uppercase">{k}</Label>
                  <select
                    className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                    value={mapping.gst[k] ?? ""}
                    onChange={(e) =>
                      setGst({ [k]: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  >
                    <option value="" className="bg-card text-muted-foreground">— none —</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i} className="bg-card text-foreground">
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Rate column</Label>
                <select
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                  value={mapping.gst.rateColumn ?? ""}
                  onChange={(e) =>
                    setGst({
                      rateColumn: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="" className="bg-card text-muted-foreground">— use a flat rate —</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i} className="bg-card text-foreground">
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs">Flat rate (%)</Label>
                <Input
                  className="mt-1"
                  type="number"
                  value={mapping.gst.flatRate ?? ""}
                  onChange={(e) =>
                    setGst({ flatRate: e.target.value === "" ? null : Number(e.target.value) })
                  }
                />
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Interstate versus intrastate is decided per row — from the party&apos;s GSTIN state
            code — because one sheet routinely contains both.
          </p>

          <Nav onBack={() => setStep("fields")} onNext={() => setStep("ledgers")} />
        </section>
      )}

      {step === "ledgers" && mapping && (
        <section className="space-y-4 rounded-lg border p-6">
          <h2 className="font-medium">Which Tally ledgers do these post to?</h2>
          <p className="text-xs text-muted-foreground">
            Party ledgers are resolved per row from the name and GSTIN, and any that are missing
            are listed for review before anything is created in Tally.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["primaryLedgerId", mapping.docType.startsWith("SALE") ? "Sales account" : "Purchase account"],
                ["cgstLedgerId", "CGST"],
                ["sgstLedgerId", "SGST"],
                ["igstLedgerId", "IGST"],
                ["roundOffLedgerId", "Round off"],
                ["discountLedgerId", "Discount"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <Label className="text-xs">{label}</Label>
                <select
                  className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                  value={(mapping.ledgers[key] as string | null) ?? ""}
                  onChange={(e) => setLedger(key, e.target.value || null)}
                >
                  <option value="" className="bg-card text-muted-foreground">— none —</option>
                  {ledgers.map((l) => (
                    <option key={l.id} value={l.id} className="bg-card text-foreground">
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <Nav
            onBack={() => setStep("gst")}
            onNext={() => doPreview("review")}
            nextLabel="Preview"
            busy={busy}
          />
        </section>
      )}

      {step === "review" && preview && (
        <section className="space-y-5 rounded-lg border p-6">
          <div className="flex flex-wrap gap-3">
            <Stat label="Will be created" value={String(preview.committableCount)} />
            <Stat
              label="Blocking issues"
              value={String(preview.blockingCount)}
              warn={preview.blockingCount > 0}
            />
            <Stat label="Warnings" value={String(preview.warningCount)} />
          </div>

          {preview.missingParties.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <p className="font-medium">
                {preview.missingParties.length} party ledgers are not in Tally yet
              </p>
              <p className="mt-1 text-muted-foreground">
                {preview.missingParties.slice(0, 8).join(", ")}
                {preview.missingParties.length > 8 && ` and ${preview.missingParties.length - 8} more`}
                . They will be created in Tally when you push, not now.
              </p>
            </div>
          )}

          {preview.issues.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Row</th>
                    <th className="px-3 py-2">Severity</th>
                    <th className="px-3 py-2">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.issues.slice(0, 200).map((i, n) => (
                    <tr key={n} className="border-t">
                      <td className="px-3 py-1.5 tabular-nums">{i.row + 1}</td>
                      <td
                        className={`px-3 py-1.5 ${
                          i.severity === "error" ? "text-destructive" : "text-amber-600"
                        }`}
                      >
                        {i.severity}
                      </td>
                      <td className="px-3 py-1.5">{i.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-md border p-4">
            <Label htmlFor="tpl" className="text-xs">
              Remember this layout (optional)
            </Label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id="tpl"
                placeholder="e.g. Tally export — sales"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <Save className="mt-2 size-4 text-muted-foreground" />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Next month&apos;s sheet with the same columns maps itself — for this client and
              every other client on the same accounting package.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => setStep("ledgers")} disabled={busy}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button onClick={doCommit} disabled={busy || preview.committableCount === 0}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Create {preview.committableCount} draft voucher
              {preview.committableCount === 1 ? "" : "s"}
            </Button>
            {progress && <span className="text-sm text-muted-foreground">{progress}</span>}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${warn ? "border-amber-500/40 bg-amber-500/5" : ""}`}>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Nav({
  onBack,
  onNext,
  nextLabel = "Next",
  nextDisabled,
  busy,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <Button variant="outline" onClick={onBack} disabled={busy}>
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <Button onClick={onNext} disabled={nextDisabled || busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {nextLabel}
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}
