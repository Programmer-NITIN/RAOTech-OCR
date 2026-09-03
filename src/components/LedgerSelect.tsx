"use client";

import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, ElementType } from "react";
import { Check, ChevronsUpDown, Plus, Loader2, Search, Building2, ShoppingBag, Receipt, Briefcase } from "lucide-react";

export interface LedgerOption {
  id: string;
  name: string;
  group?: string;
  ledgerType?: string;
}

export type LedgerSelectHandle = {
  focusOpen: () => void;
};

export type CategoryKey = "PARTIES" | "PURCHASE_SALES" | "DUTIES_TAXES" | "EXPENSES_OTHERS";

export interface CategoryInfo {
  key: CategoryKey;
  label: string;
  Icon: ElementType;
  bgColor: string;
  textColor: string;
}

const CATEGORIES: Record<CategoryKey, CategoryInfo> = {
  PARTIES: {
    key: "PARTIES",
    label: "Parties (Debtors / Creditors)",
    Icon: Building2,
    bgColor: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    textColor: "text-blue-400",
  },
  PURCHASE_SALES: {
    key: "PURCHASE_SALES",
    label: "Purchase & Sales Accounts",
    Icon: ShoppingBag,
    bgColor: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    textColor: "text-purple-400",
  },
  DUTIES_TAXES: {
    key: "DUTIES_TAXES",
    label: "Duties & Taxes (CGST / SGST / IGST)",
    Icon: Receipt,
    bgColor: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    textColor: "text-emerald-400",
  },
  EXPENSES_OTHERS: {
    key: "EXPENSES_OTHERS",
    label: "Expenses & Other Accounts",
    Icon: Briefcase,
    bgColor: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    textColor: "text-amber-400",
  },
};

/** Categorize a ledger based on its group and ledgerType */
export function getLedgerCategory(ledger: LedgerOption): CategoryKey {
  const grp = (ledger.group || "").toUpperCase();
  const type = (ledger.ledgerType || "").toUpperCase();
  const name = (ledger.name || "").toUpperCase();

  if (
    type === "PARTY" ||
    grp.includes("DEBTOR") ||
    grp.includes("CREDITOR") ||
    grp.includes("PARTY")
  ) {
    return "PARTIES";
  }

  if (
    type === "TAX" ||
    grp.includes("DUTIES") ||
    grp.includes("TAX") ||
    grp.includes("GST") ||
    name.includes("CGST") ||
    name.includes("SGST") ||
    name.includes("IGST")
  ) {
    return "DUTIES_TAXES";
  }

  if (
    type === "PURCHASE" ||
    type === "SALES" ||
    grp.includes("PURCHASE") ||
    grp.includes("SALES")
  ) {
    return "PURCHASE_SALES";
  }

  return "EXPENSES_OTHERS";
}

/** Determine primary category from line role */
function getPrimaryCategoryForRole(role?: string): CategoryKey | null {
  if (!role) return null;
  const r = role.toUpperCase();
  if (r === "PARTY") return "PARTIES";
  if (r === "CGST" || r === "SGST" || r === "IGST" || r === "TAX" || r === "ROUND_OFF") return "DUTIES_TAXES";
  if (r === "ITEM") return "PURCHASE_SALES";
  return null;
}

/**
 * Searchable, categorized ledger picker with smart role-prioritization and inline creation.
 */
export const LedgerSelect = forwardRef<
  LedgerSelectHandle,
  {
    ledgers: LedgerOption[];
    value: string | null;
    onChange: (ledgerId: string) => void;
    onCreated?: (ledger: LedgerOption) => void;
    placeholder?: string;
    role?: string;
  }
>(function LedgerSelect(
  {
    ledgers,
    value,
    onChange,
    onCreated,
    placeholder = "Select ledger…",
    role,
  },
  ref
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    focusOpen: () => {
      setOpen(true);
      buttonRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = ledgers.find((l) => l.id === value) || null;
  const primaryCat = useMemo(() => getPrimaryCategoryForRole(role), [role]);

  // Group ledgers by Category
  const categorized = useMemo(() => {
    const q = query.trim().toLowerCase();

    // Map all ledgers to categories
    const groups: Record<CategoryKey, LedgerOption[]> = {
      PARTIES: [],
      PURCHASE_SALES: [],
      DUTIES_TAXES: [],
      EXPENSES_OTHERS: [],
    };

    for (const l of ledgers) {
      if (q && !l.name.toLowerCase().includes(q) && !(l.group || "").toLowerCase().includes(q)) {
        continue;
      }
      const cat = getLedgerCategory(l);
      groups[cat].push(l);
    }

    // Determine category display order
    let order: CategoryKey[] = ["PARTIES", "PURCHASE_SALES", "DUTIES_TAXES", "EXPENSES_OTHERS"];
    if (primaryCat) {
      order = [primaryCat, ...order.filter((c) => c !== primaryCat)];
    }

    return order
      .map((catKey) => ({
        info: CATEGORIES[catKey],
        isPrimary: catKey === primaryCat,
        items: groups[catKey],
      }))
      .filter((g) => g.items.length > 0);
  }, [ledgers, query, primaryCat]);

  const exactExists = ledgers.some(
    (l) => l.name.toLowerCase() === query.trim().toLowerCase()
  );

  async function handleCreate() {
    const name = query.trim();
    if (!name) return;
    setCreating(true);

    // Smart defaults for group/type based on role
    let group = "INDIRECT_EXPENSES";
    let ledgerType = "EXPENSE";
    if (role === "PARTY") {
      group = "SUNDRY_CREDITORS";
      ledgerType = "PARTY";
    } else if (role === "CGST" || role === "SGST" || role === "IGST" || role === "TAX") {
      group = "DUTIES_AND_TAXES";
      ledgerType = "TAX";
    } else if (role === "ITEM") {
      group = "PURCHASE_ACCOUNTS";
      ledgerType = "PURCHASE";
    }

    try {
      const res = await fetch("/api/ledgers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, group, ledgerType }),
      });
      const data = await res.json();
      if (res.ok && data.ledger) {
        onCreated?.(data.ledger);
        onChange(data.ledger.id);
        setOpen(false);
        setQuery("");
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm text-left transition-all ${
          selected
            ? "border-border bg-card text-foreground shadow-sm hover:border-border/80 hover:bg-accent/40"
            : "border-amber-500/40 bg-amber-500/10 text-amber-400 font-medium hover:border-amber-500/60"
        }`}
      >
        <span className="truncate flex items-center gap-1.5">
          {selected ? (
            <>
              <span className="truncate font-medium">{selected.name}</span>
              {selected.group && (
                <span className="text-[10px] text-muted-foreground font-normal shrink-0">
                  ({selected.group.replace(/_/g, " ")})
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-80 md:w-96 rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl transition-all overflow-hidden left-0">
          <div className="p-2 border-b border-border bg-muted/40 flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground shrink-0 ml-1" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or category…"
              className="w-full bg-transparent border-0 px-1 py-1 text-sm outline-none text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-72 overflow-y-auto p-1 divide-y divide-border/40">
            {categorized.map(({ info, isPrimary, items }) => (
              <div key={info.key} className="py-1">
                {/* Category Header */}
                <div className="px-2 py-1 flex items-center justify-between text-xs font-semibold text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <info.Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-foreground/80">{info.label}</span>
                    {isPrimary && (
                      <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full font-medium">
                        Suggested
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] font-normal text-muted-foreground bg-muted px-1.5 rounded-full">
                    {items.length}
                  </span>
                </div>

                {/* Ledger Items under this Category */}
                <div className="space-y-0.5 mt-0.5">
                  {items.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => {
                        onChange(l.id);
                        setOpen(false);
                        setQuery("");
                      }}
                      className={`w-full flex items-center justify-between px-3 py-1.5 text-sm rounded-lg text-left transition-colors ${
                        value === l.id
                          ? "bg-primary/15 text-primary font-medium"
                          : "hover:bg-accent hover:text-accent-foreground text-foreground"
                      }`}
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="truncate font-normal">{l.name}</div>
                        {l.group && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {l.group.replace(/_/g, " ")}
                          </div>
                        )}
                      </div>
                      {value === l.id && <Check className="h-4 w-4 text-primary shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {categorized.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                No ledger matches found for &ldquo;{query}&rdquo;
              </div>
            )}
          </div>

          {query.trim() && !exactExists && (
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium border-t border-border bg-muted/20 text-primary hover:bg-primary/10 transition-colors"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create &ldquo;{query.trim()}&rdquo; as Ledger
            </button>
          )}
        </div>
      )}
    </div>
  );
});

LedgerSelect.displayName = "LedgerSelect";


