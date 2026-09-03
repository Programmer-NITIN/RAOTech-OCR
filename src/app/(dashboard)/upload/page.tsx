"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  UploadCloud,
  Loader2,
  Save,
  CheckCircle2,
  XCircle,
  Clock,
  FileText,
  AlertTriangle,
  ImageIcon,
  FileUp,
  ArrowRight,
  History,
  Plus,
} from "lucide-react";
import { detectDocumentType, detectedToDocumentType } from "@/lib/docs/detectType";

type ExtractedData = Record<string, any>;
type GSTValidation = {
  is_valid_invoice?: boolean;
  vendor_valid?: boolean;
  vendor_state?: string;
  vendor_message?: string;
  customer_valid?: boolean;
  customer_state?: string;
  customer_message?: string;
};

type LedgerSuggestion = {
  ledgerId: string;
  ledgerName: string;
  via: string;
};

type UploadDoc = {
  id: string;
  file: File;
  previewUrl: string | null;
  extractedData: ExtractedData | null;
  gstValidation: GSTValidation | null;
  processingTime: number | null;
  ocrEngine: string | null;
  error: string | null;
  extracting: boolean;
  saving: boolean;
  saved: boolean;
  // "Similar party" prompt shown after extraction
  ledgerSuggestion: LedgerSuggestion | null;
  ledgerChoice: "previous" | "new" | null;
};

const VIA_LABEL: Record<string, string> = {
  GSTIN_MEMORY: "same GSTIN used before",
  NAME_MEMORY: "same name used before",
  FUZZY: "similar name used before",
  RULE: "matches a mapping rule",
};

const MAX_FILES = 15;
const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ".pdf,.jpg,.jpeg,.png,.bmp,.tiff,.webp";

export default function UploadPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const documentsRef = useRef<UploadDoc[]>([]);
  const [documents, setDocuments] = useState<UploadDoc[]>([]);
  const [extractingAll, setExtractingAll] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [docType, setDocType] = useState<"invoice" | "bank">("invoice");
  const [autoDetected, setAutoDetected] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    docId: string;
    duplicateOfId: string | null;
  } | null>(null);

  const extractedCount = useMemo(
    () => documents.filter((doc) => !!doc.extractedData).length,
    [documents]
  );

  const savedCount = useMemo(
    () => documents.filter((doc) => doc.saved).length,
    [documents]
  );

  // First extracted doc whose party matched a prior ledger and still awaits a
  // reuse/create decision — drives the popup (shown one at a time).
  const pendingSuggestionDoc = useMemo(
    () => documents.find((doc) => doc.ledgerSuggestion && !doc.ledgerChoice) ?? null,
    [documents]
  );

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    return () => {
      documentsRef.current.forEach((doc) => {
        if (doc.previewUrl) URL.revokeObjectURL(doc.previewUrl);
      });
    };
  }, []);

  const addFiles = async (incomingFiles: File[]) => {
    if (!incomingFiles.length) return;

    // Filename heuristic first (instant)
    const guess = detectDocumentType({ fileName: incomingFiles[0].name });
    if (guess === "bank") {
      setDocType("bank");
      setAutoDetected("Bank statement (from filename)");
    } else {
      setDocType("invoice");
      setAutoDetected(
        guess === "credit_note"
          ? "Credit note (from filename)"
          : guess === "debit_note"
            ? "Debit note (from filename)"
            : "Invoice (from filename) — refining with OCR…"
      );
    }

    const supported = incomingFiles.filter(
      (f) => f.type.startsWith("image/") || f.type === "application/pdf"
    );
    const allowed = supported.filter((f) => f.size <= MAX_FILE_SIZE_BYTES);
    const unsupportedCount = incomingFiles.length - supported.length;
    const oversizedCount = supported.length - allowed.length;

    if (!allowed.length) {
      if (unsupportedCount > 0 && oversizedCount > 0) {
        setError(
          `Only PDF/image files are supported and each file must be <= ${MAX_FILE_SIZE_MB}MB.`
        );
      } else if (unsupportedCount > 0) {
        setError("Only PDF and image files are supported.");
      } else {
        setError(`Each file must be <= ${MAX_FILE_SIZE_MB}MB.`);
      }
      return;
    }

    const warnings: string[] = [];
    if (unsupportedCount > 0) {
      warnings.push(`${unsupportedCount} unsupported file(s) skipped`);
    }
    if (oversizedCount > 0) {
      warnings.push(`${oversizedCount} oversized file(s) skipped (max ${MAX_FILE_SIZE_MB}MB)`);
    }

    setDocuments((prev) => {
      const availableSlots = MAX_FILES - prev.length;
      if (availableSlots <= 0) {
        setError(`You can upload a maximum of ${MAX_FILES} documents.`);
        return prev;
      }

      const filesToAdd = allowed.slice(0, availableSlots);
      if (allowed.length > availableSlots) {
        warnings.push(`Only first ${availableSlots} file(s) were added due to ${MAX_FILES} document limit`);
      }

      setError(warnings.length ? warnings.join(". ") + "." : null);

      const nextDocs = filesToAdd.map((file, idx) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${idx}`,
        file,
        previewUrl: URL.createObjectURL(file),
        extractedData: null,
        gstValidation: null,
        processingTime: null,
        ocrEngine: null,
        error: null,
        extracting: false,
        saving: false,
        saved: false,
        ledgerSuggestion: null,
        ledgerChoice: null,
      }));

      return [...prev, ...nextDocs];
    });

    // Vision classify first file (async refine)
    void classifyFirstFile(allowed[0]);
  };

  const classifyFirstFile = async (file: File) => {
    setClassifying(true);
    try {
      const data = new FormData();
      data.append("file", file);
      const res = await fetch("/api/classify-doc", { method: "POST", body: data });
      const json = await res.json();
      if (!res.ok) return;
      const t = json.doc_type as string;
      const conf = Math.round((json.confidence || 0) * 100);
      const src = json.source === "ocr" ? "OCR" : "filename";
      if (t === "bank") {
        setDocType("bank");
        setAutoDetected(`Bank statement (${src}, ${conf}% conf)`);
      } else {
        setDocType("invoice");
        setAutoDetected(
          `${String(t).replace("_", " ")} (${src}, ${conf}% conf)`
        );
      }
    } catch {
      /* keep filename guess */
    } finally {
      setClassifying(false);
    }
  };

  const removeDocument = (id: string) => {
    setDocuments((prev) => {
      const docToRemove = prev.find((doc) => doc.id === id);
      if (docToRemove?.previewUrl) {
        URL.revokeObjectURL(docToRemove.previewUrl);
      }
      return prev.filter((doc) => doc.id !== id);
    });
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    addFiles(droppedFiles);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const extractSingle = async (id: string) => {
    const doc = documents.find((d) => d.id === id);
    if (!doc) return;

    setDocuments((prev) =>
      prev.map((d) =>
        d.id === id
          ? {
              ...d,
              extracting: true,
              error: null,
              extractedData: null,
              saved: false,
              ledgerSuggestion: null,
              ledgerChoice: null,
            }
          : d
      )
    );

    const data = new FormData();
    data.append("file", doc.file);

    try {
      const endpoint = docType === "bank" ? "/api/process-bank" : "/api/process-invoice";
      const res = await fetch(endpoint, { method: "POST", body: data });
      const json = await res.json();

      if (!res.ok || json.error) {
        setDocuments((prev) =>
          prev.map((d) => (d.id === id ? { ...d, error: json.error || "Extraction failed", extracting: false } : d))
        );
        return;
      }

      const extracted = json.data || json;
      // Refine type from extracted content
      const refined = detectDocumentType({ fileName: doc.file.name, extracted });
      if (refined === "bank") setDocType("bank");
      setAutoDetected(`Detected: ${refined.replace("_", " ")}`);

      setDocuments((prev) =>
        prev.map((d) =>
          d.id === id
            ? {
                ...d,
                extractedData: extracted,
                gstValidation: json.gst_validation || null,
                processingTime: json.processing_time || null,
                ocrEngine: json.ocr_engine || null,
                extracting: false,
                error: null,
              }
            : d
        )
      );

      // Invoices only: check whether this party was mapped before and, if so,
      // prompt the user to reuse that ledger or create a new one.
      if (docType === "invoice") {
        void fetchLedgerSuggestion(id, extracted);
      }
    } catch {
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === id
            ? {
                ...d,
                extracting: false,
                error: "Failed to connect to server. Make sure OCR backend is running.",
              }
            : d
        )
      );
    }
  };

  // Ask the backend whether this vendor was mapped to a ledger before.
  const fetchLedgerSuggestion = async (id: string, extracted: ExtractedData) => {
    try {
      const res = await fetch("/api/ledgers/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor: extracted?.vendor ?? null,
          vendorGstin: extracted?.vendor_gstin ?? null,
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      if (json?.match) {
        setDocuments((prev) =>
          prev.map((d) =>
            d.id === id && !d.ledgerChoice
              ? { ...d, ledgerSuggestion: json.match as LedgerSuggestion }
              : d
          )
        );
      }
    } catch {
      /* suggestion is best-effort — never block the flow */
    }
  };

  // Record the user's answer to the "reuse ledger?" popup.
  const resolveLedgerChoice = (id: string, choice: "previous" | "new") => {
    setDocuments((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ledgerChoice: choice } : d))
    );
  };

  const handleExtractAll = async () => {
    if (!documents.length) return;
    setExtractingAll(true);
    setError(null);
    for (const doc of documents) {
      await extractSingle(doc.id);
    }
    setExtractingAll(false);
  };

  const handleFieldChange = (id: string, key: string, value: any) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id !== id || !doc.extractedData) return doc;
        return {
          ...doc,
          extractedData: {
            ...doc.extractedData,
            [key]: value,
          },
          saved: false,
        };
      })
    );
  };

  const saveSingle = async (
    id: string,
    opts?: { allowDuplicate?: boolean }
  ): Promise<{ voucherId: string | null } | null> => {
    const doc = documents.find((d) => d.id === id);
    if (!doc?.extractedData) return null;

    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, saving: true, error: null } : d)));

    try {
      const res = await fetch("/api/invoices/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extractedData: doc.extractedData,
          gstValidation: doc.gstValidation,
          fileName: doc.file.name || "invoice",
          processingTime: doc.processingTime,
          ocrEngine: doc.ocrEngine,
          documentType: detectedToDocumentType(
            detectDocumentType({ fileName: doc.file.name, extracted: doc.extractedData })
          ),
          partyLedgerId:
            doc.ledgerChoice === "previous" ? doc.ledgerSuggestion?.ledgerId ?? null : null,
          forceNewParty: doc.ledgerChoice === "new",
          allowDuplicate: !!opts?.allowDuplicate,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (res.status === 409 && json.code === "DUPLICATE_INVOICE") {
        setDocuments((prev) =>
          prev.map((d) => (d.id === id ? { ...d, saving: false } : d))
        );
        setPendingDuplicate({ docId: id, duplicateOfId: json.duplicateOfId ?? null });
        return null;
      }

      if (res.ok) {
        setDocuments((prev) =>
          prev.map((d) => (d.id === id ? { ...d, saving: false, saved: true, error: null } : d))
        );
        return { voucherId: json.voucherId ?? null };
      } else {
        setDocuments((prev) =>
          prev.map((d) =>
            d.id === id
              ? { ...d, saving: false, saved: false, error: `Failed to save: ${json.error || "Unknown error"}` }
              : d
          )
        );
        return null;
      }
    } catch {
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, saving: false, saved: false, error: "Error saving invoice." } : d
        )
      );
      return null;
    }
  };

  const confirmDuplicateSave = async () => {
    if (!pendingDuplicate) return;
    const { docId } = pendingDuplicate;
    setPendingDuplicate(null);
    const result = await saveSingle(docId, { allowDuplicate: true });
    if (result?.voucherId) router.push(`/vouchers/${result.voucherId}`);
  };

  // Save a single document and jump straight to its ledger-mapping screen
  const saveAndMap = async (id: string) => {
    const result = await saveSingle(id);
    if (result?.voucherId) {
      router.push(`/vouchers/${result.voucherId}`);
    } else if (result) {
      router.push("/transactions");
    }
  };

  // Bank statement: save the extracted transactions and open its mapping screen
  const saveBankAndMap = async (id: string) => {
    const doc = documents.find((d) => d.id === id);
    if (!doc?.extractedData) return;
    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, saving: true, error: null } : d)));
    try {
      const res = await fetch("/api/bank-statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: doc.file.name || "bank-statement", data: doc.extractedData }),
      });
      const json = await res.json();
      if (res.ok && json.statementId) {
        router.push(`/bank/${json.statementId}`);
      } else {
        setDocuments((prev) =>
          prev.map((d) => (d.id === id ? { ...d, saving: false, error: json.error || "Failed to save" } : d))
        );
      }
    } catch {
      setDocuments((prev) =>
        prev.map((d) => (d.id === id ? { ...d, saving: false, error: "Error saving statement." } : d))
      );
    }
  };

  const handleSaveAll = async () => {
    if (!documents.length) {
      setError("Add documents before saving.");
      return;
    }

    if (documents.some((doc) => !doc.extractedData)) {
      setError("Extract all documents before Save All.");
      return;
    }

    const readyToSave = documents.filter((doc) => !!doc.extractedData && !doc.saved);
    if (!readyToSave.length) {
      setError("All extracted documents are already saved.");
      return;
    }

    setSavingAll(true);
    setError(null);

    let failed = 0;
    for (const doc of readyToSave) {
      const ok = await saveSingle(doc.id);
      if (!ok) failed += 1;
    }

    setSavingAll(false);

    if (failed === 0) {
      router.push("/transactions");
    } else {
      setError(`${failed} document(s) failed to save. Fix errors and try again.`);
    }
  };

  const formatCurrency = (val: any) => {
    const num = typeof val === "number" ? val : parseFloat(val);
    if (isNaN(num)) return val;
    return `₹${num.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6" style={{ background: "var(--spx-canvas)" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            className="font-bold uppercase text-[var(--spx-text)]"
            style={{ fontSize: "22px", letterSpacing: "2px", fontFamily: "'Inter', 'Geist Sans', system-ui, sans-serif" }}
          >
            Upload &amp; Extract {docType === "bank" ? "Bank Statements" : "Invoices"}
          </h2>
          <p
            className="mt-1"
            style={{ fontSize: "11px", letterSpacing: "1.5px", color: "var(--spx-muted)", textTransform: "uppercase" as const }}
          >
            AI ingestion &amp; OCR extraction pipeline
          </p>
        </div>
        <div className="flex overflow-hidden text-sm" style={{ border: "1px solid var(--spx-border)" }}>
          {([["invoice", "Invoice"], ["bank", "Bank Statement"]] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => {
                setDocType(val);
                setAutoDetected(null);
              }}
              className="uppercase transition-colors"
              style={{
                padding: "9px 18px",
                fontSize: "11px",
                letterSpacing: "1.2px",
                fontWeight: 500,
                background: docType === val ? "var(--spx-text)" : "transparent",
                color: docType === val ? "var(--spx-canvas)" : "var(--spx-muted)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {autoDetected && (
        <div
          className="flex items-center gap-2 text-sm"
          style={{ border: "1px solid var(--spx-border)", background: "var(--spx-card)", padding: "10px 14px", color: "var(--spx-text-secondary)" }}
        >
          {classifying && <Loader2 className="h-4 w-4 animate-spin shrink-0 text-[var(--spx-text)]" />}
          <span>
            <span className="text-[var(--spx-text)]">Auto-detected:</span> {autoDetected}{" "}
            <span style={{ color: "var(--spx-muted)" }}>(you can override with the toggle)</span>
          </span>
        </div>
      )}

      {/* Upload Area */}
      <div
        className="text-center transition-all cursor-pointer"
        style={{
          border: `1px dashed ${isDragging ? "var(--spx-text)" : "var(--spx-border)"}`,
          background: isDragging ? "var(--spx-input-bg)" : "var(--spx-card)",
          padding: "40px 32px",
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          className="hidden"
          onChange={(e) => {
            const selectedFiles = Array.from(e.target.files || []);
            addFiles(selectedFiles);
            e.currentTarget.value = "";
          }}
        />
        <UploadCloud className="mx-auto h-10 w-10 mb-4" style={{ color: "var(--spx-muted)" }} strokeWidth={1.5} />
        <p className="text-[var(--spx-text)]" style={{ fontSize: "15px", fontWeight: 500 }}>
          {documents.length
            ? `${documents.length} document(s) selected`
            : "Drag & drop up to 15 invoice files here"}
        </p>
        <p className="mt-1" style={{ fontSize: "12px", color: "var(--spx-muted)" }}>
          Supports PDF, JPG, PNG, BMP, TIFF, WEBP (max 20MB each)
        </p>

        {documents.length > 0 && (
          <div className="mt-5 flex items-center justify-center gap-4">
            <span style={{ fontSize: "12px", color: "var(--spx-muted)" }}>
              Extracted {extractedCount}/{documents.length}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleExtractAll();
              }}
              disabled={extractingAll}
              className="inline-flex items-center uppercase disabled:opacity-50"
              style={{
                background: "var(--spx-text)",
                color: "var(--spx-canvas)",
                padding: "9px 18px",
                fontSize: "11px",
                letterSpacing: "1.2px",
                fontWeight: 600,
              }}
            >
              {extractingAll ? (
                <>
                  <Loader2 className="animate-spin mr-2 h-4 w-4" />
                  Extracting All...
                </>
              ) : (
                <>
                  <FileText className="mr-2 h-4 w-4" />
                  Extract All
                </>
              )}
            </button>
            {docType === "invoice" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleSaveAll();
                }}
                disabled={
                  savingAll ||
                  !documents.length ||
                  extractedCount !== documents.length ||
                  savedCount === documents.length
                }
                className="inline-flex items-center uppercase disabled:opacity-50"
                style={{
                  background: "transparent",
                  color: "var(--spx-text)",
                  border: "1px solid var(--spx-border)",
                  padding: "9px 18px",
                  fontSize: "11px",
                  letterSpacing: "1.2px",
                  fontWeight: 600,
                }}
              >
                {savingAll ? (
                  <>
                    <Loader2 className="animate-spin mr-2 h-4 w-4" />
                    Saving All...
                  </>
                ) : savedCount === documents.length ? (
                  <>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    All Saved
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    Save All Invoices
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div
          className="flex items-center gap-2"
          style={{ border: "1px solid #7f1d1d", background: "rgba(127,29,29,0.15)", padding: "12px 16px", color: "#fca5a5" }}
        >
          <XCircle className="h-5 w-5 shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {documents.length > 0 && (
        <div
          style={{ border: "1px solid var(--spx-border)", background: "var(--spx-card)", padding: "10px 14px", fontSize: "12px", color: "var(--spx-text-secondary)" }}
        >
          Added {documents.length}/{MAX_FILES} documents &middot; Extracted {extractedCount} &middot; Saved {savedCount}
        </div>
      )}

      {/* Results */}
      <div className="space-y-6">
        {documents.map((doc, docIndex) => (
          <div
            key={doc.id}
            className="space-y-4 animate-in fade-in"
            style={{ border: "1px solid var(--spx-border)", background: "var(--spx-card)", padding: "24px" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="flex items-center gap-2 text-white" style={{ fontSize: "15px", fontWeight: 600 }}>
                  <FileUp className="h-4 w-4" style={{ color: "var(--spx-muted)" }} />
                  {docIndex + 1}. {doc.file.name}
                </h3>
                <p className="mt-1" style={{ fontSize: "11px", color: "var(--spx-muted)" }}>
                  {(doc.file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {doc.ledgerChoice === "previous" && doc.ledgerSuggestion && (
                  <span
                    className="inline-flex items-center gap-1 uppercase"
                    style={{ border: "1px solid #1e3a5f", color: "#7dd3fc", padding: "4px 10px", fontSize: "10px", letterSpacing: "0.8px" }}
                  >
                    <History className="h-3 w-3" /> Reusing {doc.ledgerSuggestion.ledgerName}
                  </span>
                )}
                {doc.ledgerChoice === "new" && (
                  <span
                    className="inline-flex items-center gap-1 uppercase"
                    style={{ border: "1px solid #5c4517", color: "#fbbf24", padding: "4px 10px", fontSize: "10px", letterSpacing: "0.8px" }}
                  >
                    <Plus className="h-3 w-3" /> New ledger
                  </span>
                )}
                {doc.saved && (
                  <span
                    className="inline-flex items-center gap-1 uppercase"
                    style={{ border: "1px solid #14532d", color: "#4ade80", padding: "4px 10px", fontSize: "10px", letterSpacing: "0.8px" }}
                  >
                    <CheckCircle2 className="h-3 w-3" /> Saved
                  </span>
                )}
                <button
                  onClick={() => extractSingle(doc.id)}
                  disabled={doc.extracting}
                  className="inline-flex items-center uppercase disabled:opacity-50"
                  style={{ border: "1px solid var(--spx-border)", color: "var(--spx-text)", background: "transparent", padding: "8px 14px", fontSize: "11px", letterSpacing: "1px" }}
                >
                  {doc.extracting ? (
                    <>
                      <Loader2 className="animate-spin mr-2 h-4 w-4" /> Extracting
                    </>
                  ) : (
                    <>
                      <FileText className="mr-2 h-4 w-4" /> {doc.extractedData ? "Re-extract" : "Extract"}
                    </>
                  )}
                </button>
                {doc.extractedData && (
                  <button
                    onClick={() => (docType === "bank" ? saveBankAndMap(doc.id) : saveAndMap(doc.id))}
                    disabled={doc.saving}
                    className="inline-flex items-center uppercase disabled:opacity-50"
                    style={{ background: "var(--spx-text)", color: "var(--spx-canvas)", padding: "8px 14px", fontSize: "11px", letterSpacing: "1px", fontWeight: 600 }}
                  >
                    {doc.saving ? (
                      <>
                        <Loader2 className="animate-spin mr-2 h-4 w-4" /> Saving
                      </>
                    ) : (
                      <>
                        {docType === "bank" ? "Map Transactions" : "Map Ledgers"}{" "}
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </button>
                )}
                <button
                  onClick={() => removeDocument(doc.id)}
                  className="inline-flex items-center uppercase"
                  style={{ border: "1px solid var(--spx-border)", color: "var(--spx-muted)", background: "transparent", padding: "8px 14px", fontSize: "11px", letterSpacing: "1px" }}
                >
                  Remove
                </button>
              </div>
            </div>

            {doc.error && (
              <div
                className="flex items-center gap-2"
                style={{ border: "1px solid #7f1d1d", background: "rgba(127,29,29,0.15)", padding: "10px 14px", color: "#fca5a5" }}
              >
                <XCircle className="h-5 w-5 shrink-0" />
                <p className="text-sm">{doc.error}</p>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1" style={{ border: "1px solid var(--spx-border)", background: "var(--spx-card)", padding: "16px" }}>
                <h4
                  className="mb-3 flex items-center gap-1 uppercase"
                  style={{ fontSize: "11px", letterSpacing: "1.2px", color: "var(--spx-muted)" }}
                >
                  <ImageIcon className="h-3.5 w-3.5" /> Preview
                </h4>

                {doc.file.type === "application/pdf" && doc.previewUrl ? (
                  <iframe
                    src={doc.previewUrl}
                    title={`Preview ${doc.file.name}`}
                    className="w-full h-[420px]"
                    style={{ border: "1px solid var(--spx-border)" }}
                  />
                ) : doc.previewUrl ? (
                  <img
                    src={doc.previewUrl}
                    alt={doc.file.name}
                    className="w-full object-contain max-h-[420px]"
                    style={{ border: "1px solid var(--spx-border)" }}
                  />
                ) : (
                  <p style={{ fontSize: "12px", color: "var(--spx-muted)" }}>Preview not available</p>
                )}
              </div>

              <div className="lg:col-span-2" style={{ border: "1px solid var(--spx-border)", background: "var(--spx-card)", padding: "24px" }}>
                <div className="flex flex-wrap gap-3 items-center mb-6">
                  {doc.processingTime && (
                    <div
                      className="flex items-center gap-1 uppercase"
                      style={{ border: "1px solid var(--spx-border)", color: "var(--spx-text-secondary)", padding: "5px 12px", fontSize: "10px", letterSpacing: "0.8px" }}
                    >
                      <Clock className="h-3 w-3" />
                      {doc.processingTime.toFixed(1)}s
                    </div>
                  )}
                  {doc.ocrEngine && (
                    <div
                      className="uppercase"
                      style={{ border: "1px solid var(--spx-border)", color: "var(--spx-text-secondary)", padding: "5px 12px", fontSize: "10px", letterSpacing: "0.8px" }}
                    >
                      Model: {doc.ocrEngine}
                    </div>
                  )}
                  {doc.gstValidation && (
                    <div
                      className="flex items-center gap-1 uppercase"
                      style={{
                        border: `1px solid ${doc.gstValidation.is_valid_invoice ? "#14532d" : "#5c4517"}`,
                        color: doc.gstValidation.is_valid_invoice ? "#4ade80" : "#fbbf24",
                        padding: "5px 12px",
                        fontSize: "10px",
                        letterSpacing: "0.8px",
                      }}
                    >
                      {doc.gstValidation.is_valid_invoice ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      GST {doc.gstValidation.is_valid_invoice ? "Valid" : "Warning"}
                      {doc.gstValidation.vendor_state && ` - ${doc.gstValidation.vendor_state}`}
                    </div>
                  )}
                </div>

                {doc.extractedData ? (
                  docType === "bank" ? (
                    <BankSummary data={doc.extractedData} />
                  ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                      <Field label="Invoice Number" value={doc.extractedData.invoice_number} onChange={(v) => handleFieldChange(doc.id, "invoice_number", v)} />
                      <Field label="Date" value={doc.extractedData.date} onChange={(v) => handleFieldChange(doc.id, "date", v)} />
                      <Field label="Vendor" value={doc.extractedData.vendor} onChange={(v) => handleFieldChange(doc.id, "vendor", v)} />
                      <Field label="Vendor GSTIN" value={doc.extractedData.vendor_gstin} onChange={(v) => handleFieldChange(doc.id, "vendor_gstin", v)} />
                      <Field label="Vendor Address" value={doc.extractedData.vendor_address} onChange={(v) => handleFieldChange(doc.id, "vendor_address", v)} />
                      <Field label="Vendor Phone" value={doc.extractedData.vendor_phone} onChange={(v) => handleFieldChange(doc.id, "vendor_phone", v)} />
                      <Field label="Customer Name" value={doc.extractedData.customer_name} onChange={(v) => handleFieldChange(doc.id, "customer_name", v)} />
                      <Field label="Customer GSTIN" value={doc.extractedData.customer_gstin} onChange={(v) => handleFieldChange(doc.id, "customer_gstin", v)} />
                    </div>

                    {doc.extractedData.items && doc.extractedData.items.length > 0 && (
                      <div className="mb-6">
                        <h4 className="mb-3 uppercase" style={{ fontSize: "11px", letterSpacing: "1.2px", color: "var(--spx-muted)" }}>
                          Line Items
                        </h4>
                        <div className="overflow-x-auto" style={{ border: "1px solid var(--spx-border)" }}>
                          <table className="w-full text-sm">
                            <thead style={{ background: "var(--spx-input-bg)" }}>
                              <tr>
                                <th className="px-4 py-2 text-left uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>#</th>
                                <th className="px-4 py-2 text-left uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Description</th>
                                <th className="px-4 py-2 text-left uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>HSN</th>
                                <th className="px-4 py-2 text-right uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Qty</th>
                                <th className="px-4 py-2 text-right uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Rate</th>
                                <th className="px-4 py-2 text-right uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {doc.extractedData.items.map((item: any, i: number) => (
                                <tr key={i} style={{ borderTop: "1px solid var(--spx-border)" }}>
                                  <td className="px-4 py-2" style={{ color: "var(--spx-muted)" }}>{i + 1}</td>
                                  <td className="px-4 py-2 text-white font-medium">{item.name || item.description || "-"}</td>
                                  <td className="px-4 py-2" style={{ color: "var(--spx-text-secondary)" }}>{item.hsn_code || "-"}</td>
                                  <td className="px-4 py-2 text-right" style={{ color: "var(--spx-text-secondary)" }}>{item.qty ?? "-"}</td>
                                  <td className="px-4 py-2 text-right" style={{ color: "var(--spx-text-secondary)" }}>{item.rate != null ? formatCurrency(item.rate) : "-"}</td>
                                  <td className="px-4 py-2 text-right text-white font-semibold">
                                    {item.price != null
                                      ? formatCurrency(item.price)
                                      : item.amount != null
                                      ? formatCurrency(item.amount)
                                      : "-"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    <div className="pt-4" style={{ borderTop: "1px solid var(--spx-border)" }}>
                      <h4 className="mb-3 uppercase" style={{ fontSize: "11px", letterSpacing: "1.2px", color: "var(--spx-muted)" }}>
                        Amounts &amp; Tax
                      </h4>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <AmountCard label="Subtotal" value={doc.extractedData.subtotal} />
                        {doc.extractedData.cgst != null && <AmountCard label="CGST" value={doc.extractedData.cgst} />}
                        {doc.extractedData.sgst != null && <AmountCard label="SGST" value={doc.extractedData.sgst} />}
                        {doc.extractedData.igst != null && <AmountCard label="IGST" value={doc.extractedData.igst} />}
                        <AmountCard label="Total Tax" value={doc.extractedData.tax} />
                        {doc.extractedData.discount != null && <AmountCard label="Discount" value={doc.extractedData.discount} />}
                        <AmountCard label="Grand Total" value={doc.extractedData.total_amount} highlight />
                      </div>
                    </div>

                    {doc.extractedData.amount_in_words && (
                      <div className="mt-4 text-sm italic" style={{ color: "var(--spx-muted)" }}>
                        Amount in words: {doc.extractedData.amount_in_words}
                      </div>
                    )}
                  </>
                  )
                ) : (
                  <div style={{ border: "1px dashed var(--spx-border)", background: "var(--spx-card)", padding: "20px", fontSize: "13px", color: "var(--spx-muted)" }}>
                    Extract this document to render editable fields.
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {pendingSuggestionDoc && pendingSuggestionDoc.ledgerSuggestion && (
        <LedgerReusePopup
          fileName={pendingSuggestionDoc.file.name}
          vendor={pendingSuggestionDoc.extractedData?.vendor || "this party"}
          suggestion={pendingSuggestionDoc.ledgerSuggestion}
          onReuse={() => resolveLedgerChoice(pendingSuggestionDoc.id, "previous")}
          onCreateNew={() => resolveLedgerChoice(pendingSuggestionDoc.id, "new")}
        />
      )}

      {pendingDuplicate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-md" style={{ background: "var(--spx-card)", border: "1px solid var(--spx-border)" }}>
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center" style={{ border: "1px solid #5c4517", color: "#fbbf24" }}>
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-white" style={{ fontSize: "16px", fontWeight: 700 }}>Possible duplicate</h3>
                  <p className="mt-1" style={{ fontSize: "13px", color: "var(--spx-text-secondary)" }}>
                    Same invoice number, vendor, and amount already exist for this client.
                    Saving again will create another voucher marked as duplicate.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex gap-3 p-4" style={{ borderTop: "1px solid var(--spx-border)" }}>
              <button
                className="flex-1 uppercase"
                style={{ border: "1px solid var(--spx-border)", color: "var(--spx-text)", background: "transparent", padding: "10px", fontSize: "11px", letterSpacing: "1px" }}
                onClick={() => setPendingDuplicate(null)}
              >
                Cancel
              </button>
              <button
                className="flex-1 uppercase"
                style={{ background: "var(--spx-text)", color: "var(--spx-canvas)", padding: "10px", fontSize: "11px", letterSpacing: "1px", fontWeight: 600 }}
                onClick={confirmDuplicateSave}
              >
                Save anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LedgerReusePopup({
  fileName,
  vendor,
  suggestion,
  onReuse,
  onCreateNew,
}: {
  fileName: string;
  vendor: string;
  suggestion: LedgerSuggestion;
  onReuse: () => void;
  onCreateNew: () => void;
}) {
  const reason = VIA_LABEL[suggestion.via] || "matched from history";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-md animate-in zoom-in-95" style={{ background: "var(--spx-card)", border: "1px solid var(--spx-border)" }}>
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center" style={{ border: "1px solid #1e3a5f", color: "#7dd3fc" }}>
              <History className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-white" style={{ fontSize: "16px", fontWeight: 700 }}>Party seen before</h3>
              <p className="mt-0.5 truncate" style={{ fontSize: "12px", color: "var(--spx-muted)" }}>{fileName}</p>
            </div>
          </div>

          <div className="mt-4 space-y-3 text-sm">
            <p style={{ color: "var(--spx-text-secondary)" }}>
              <span className="font-semibold text-white">{vendor}</span> looks like a party you&apos;ve
              already mapped ({reason}).
            </p>
            <div style={{ border: "1px solid #1e3a5f", background: "rgba(30,58,95,0.15)", padding: "12px 16px" }}>
              <p className="uppercase" style={{ fontSize: "10px", letterSpacing: "1px", color: "#7dd3fc" }}>Previously used ledger</p>
              <p className="mt-0.5 text-white" style={{ fontSize: "15px", fontWeight: 600 }}>
                {suggestion.ledgerName}
              </p>
            </div>
            <p style={{ color: "var(--spx-muted)" }}>
              Reuse this ledger for consistency, or create a new one for this invoice.
            </p>
          </div>
        </div>

        <div className="flex gap-3 p-4" style={{ borderTop: "1px solid var(--spx-border)" }}>
          <button
            className="flex-1 inline-flex items-center justify-center uppercase"
            style={{ border: "1px solid var(--spx-border)", color: "var(--spx-text)", background: "transparent", padding: "10px", fontSize: "11px", letterSpacing: "1px" }}
            onClick={onCreateNew}
          >
            <Plus className="mr-2 h-4 w-4" /> Create new
          </button>
          <button
            className="flex-1 inline-flex items-center justify-center uppercase"
            style={{ background: "var(--spx-text)", color: "var(--spx-canvas)", padding: "10px", fontSize: "11px", letterSpacing: "1px", fontWeight: 600 }}
            onClick={onReuse}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" /> Use previous
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: any;
  onChange: (v: string) => void;
}) {
  if (value == null || value === "") return null;
  return (
    <div className="space-y-1">
      <Label className="uppercase" style={{ fontSize: "10px", letterSpacing: "1px", color: "var(--spx-muted)", fontWeight: 500 }}>{label}</Label>
      <Input
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "var(--spx-canvas, #0b0d10)",
          color: "var(--spx-text, #ffffff)",
          border: "1px solid var(--spx-border)",
          borderRadius: 0,
        }}
      />
    </div>
  );
}

function AmountCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: any;
  highlight?: boolean;
}) {
  if (value == null) return null;
  const num = typeof value === "number" ? value : parseFloat(value);
  const display = isNaN(num) ? value : `₹${num.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

  return (
    <div
      className="p-3"
      style={{
        border: highlight ? "1px solid var(--spx-active-border)" : "1px solid var(--spx-border)",
        background: highlight ? "var(--spx-input-bg)" : "var(--spx-card)",
      }}
    >
      <p className="uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>{label}</p>
      <p style={{ fontSize: "16px", fontWeight: 700, color: highlight ? "var(--spx-text, #ffffff)" : "#e2e1eb" }}>
        {display}
      </p>
    </div>
  );
}

function BankSummary({ data }: { data: any }) {
  const txns: any[] = Array.isArray(data?.transactions) ? data.transactions : [];
  const fmt = (n: any) => {
    const num = typeof n === "number" ? n : parseFloat(n);
    return isNaN(num) || num === 0 ? "" : `₹${num.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        <span className="uppercase" style={{ border: "1px solid var(--spx-border)", color: "var(--spx-text-secondary)", padding: "5px 12px", fontSize: "10px", letterSpacing: "0.8px" }}>
          Bank: {data?.bank_name || "—"}
        </span>
        <span className="uppercase" style={{ border: "1px solid var(--spx-border)", color: "var(--spx-text-secondary)", padding: "5px 12px", fontSize: "10px", letterSpacing: "0.8px" }}>
          A/C: {data?.account_number || "—"}
        </span>
        <span className="uppercase font-medium" style={{ border: "1px solid #14532d", color: "#4ade80", padding: "5px 12px", fontSize: "10px", letterSpacing: "0.8px" }}>
          {txns.length} transactions
        </span>
      </div>
      <div className="overflow-auto max-h-80" style={{ border: "1px solid var(--spx-border)" }}>
        <table className="w-full text-sm">
          <thead className="sticky top-0" style={{ background: "var(--spx-input-bg)" }}>
            <tr>
              <th className="px-3 py-2 text-left uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Date</th>
              <th className="px-3 py-2 text-left uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Description</th>
              <th className="px-3 py-2 text-right uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Withdrawal</th>
              <th className="px-3 py-2 text-right uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Deposit</th>
              <th className="px-3 py-2 text-right uppercase" style={{ fontSize: "10px", letterSpacing: "0.8px", color: "var(--spx-muted)" }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--spx-border)" }}>
                <td className="px-3 py-2 whitespace-nowrap" style={{ color: "var(--spx-text-secondary)" }}>{t.date || "—"}</td>
                <td className="px-3 py-2 text-white">{t.description || "—"}</td>
                <td className="px-3 py-2 text-right" style={{ color: "#f87171" }}>{fmt(t.withdrawal)}</td>
                <td className="px-3 py-2 text-right" style={{ color: "#4ade80" }}>{fmt(t.deposit)}</td>
                <td className="px-3 py-2 text-right" style={{ color: "var(--spx-text-secondary)" }}>{fmt(t.balance)}</td>
              </tr>
            ))}
            {txns.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center" style={{ color: "var(--spx-muted)" }}>No transactions detected.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2" style={{ fontSize: "11px", color: "var(--spx-muted)" }}>
        Click <strong className="text-white">Map Transactions</strong> to assign a ledger to each row and send to Tally.
      </p>
    </div>
  );
}
