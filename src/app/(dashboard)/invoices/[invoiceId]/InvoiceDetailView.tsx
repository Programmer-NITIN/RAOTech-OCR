"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Save,
  Loader2,
  CheckCircle2,
  XCircle,
  Building2,
  FileText,
  Trash2,
  Pencil,
} from "lucide-react";

type Invoice = {
  id: string;
  invoiceNumber?: string | null;
  date?: string | null;
  totalAmount?: number | null;
  taxAmount?: number | null;
  vendor?: string | null;
  vendorGstin?: string | null;
  vendorAddress?: string | null;
  vendorPhone?: string | null;
  customerName?: string | null;
  customerGstin?: string | null;
  subtotal?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  igst?: number | null;
  discount?: number | null;
  gstValid?: boolean | null;
  gstState?: string | null;
  ocrEngine?: string | null;
  processingTime?: number | null;
  status: string;
  items?: any[] | null;
  extractedData?: any;
  createdAt: string;
  updatedAt: string;
};

export default function InvoiceDetailView({ invoice }: { invoice: Invoice }) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editData, setEditData] = useState(invoice.extractedData || {});

  const items: any[] = invoice.items || invoice.extractedData?.items || [];

  const formatCurrency = (val: any) => {
    if (val == null) return "-";
    const num = typeof val === "number" ? val : parseFloat(val);
    if (isNaN(num)) return "-";
    return `₹${num.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extractedData: editData }),
      });
      if (res.ok) {
        setIsEditing(false);
        router.refresh();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this invoice?")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/invoices/${invoice.id}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/dashboard");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-6 text-slate-900 dark:text-slate-100">
      {/* Header */}
      <div className="flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => router.back()} className="dark:border-slate-700 dark:hover:bg-slate-800">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-slate-100">
              <FileText className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              {invoice.invoiceNumber || "Untitled Invoice"}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Created {new Date(invoice.createdAt).toLocaleDateString("en-IN")}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          {!isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} className="dark:border-slate-700 dark:hover:bg-slate-800">
                <Pencil className="mr-1 h-4 w-4" /> Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 dark:border-slate-700"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? <Loader2 className="animate-spin h-4 w-4" /> : <Trash2 className="mr-1 h-4 w-4" />}
                Delete
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(false)} className="dark:border-slate-700 dark:hover:bg-slate-800">
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving} className="bg-green-600 hover:bg-green-700 text-white">
                {saving ? <Loader2 className="animate-spin mr-1 h-4 w-4" /> : <Save className="mr-1 h-4 w-4" />}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Status & GST Badges */}
      <div className="flex flex-wrap gap-3">
        <span
          className={`px-3 py-1 rounded-full text-xs font-bold ${
            invoice.status === "PROCESSED"
              ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300"
              : invoice.status === "FAILED"
              ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
              : "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300"
          }`}
        >
          {invoice.status}
        </span>
        {invoice.gstValid != null && (
          <span
            className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold ${
              invoice.gstValid
                ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300"
                : "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
            }`}
          >
            {invoice.gstValid ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            GST {invoice.gstValid ? "Valid" : "Invalid"}
          </span>
        )}
        {invoice.gstState && (
          <span className="px-3 py-1 rounded-full text-xs bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300 font-medium">
            {invoice.gstState}
          </span>
        )}
        {invoice.ocrEngine && (
          <span className="px-3 py-1 rounded-full text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-medium">
            {invoice.ocrEngine}
          </span>
        )}
        {invoice.processingTime && (
          <span className="px-3 py-1 rounded-full text-xs bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-medium">
            {invoice.processingTime.toFixed(1)}s
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Vendor Info */}
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-4 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-600 dark:text-blue-400" /> Vendor Details
          </h3>
          <div className="space-y-3">
            <InfoRow label="Vendor Name" value={invoice.vendor} />
            <InfoRow label="GSTIN" value={invoice.vendorGstin} mono />
            <InfoRow label="Address" value={invoice.vendorAddress} />
            <InfoRow label="Phone" value={invoice.vendorPhone} />
          </div>
        </div>

        {/* Customer & Invoice Info */}
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-4 flex items-center gap-2">
            <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" /> Invoice Details
          </h3>
          <div className="space-y-3">
            <InfoRow label="Invoice #" value={invoice.invoiceNumber} />
            <InfoRow
              label="Date"
              value={invoice.date ? new Date(invoice.date).toLocaleDateString("en-IN") : null}
            />
            <InfoRow label="Customer" value={invoice.customerName} />
            <InfoRow label="Customer GSTIN" value={invoice.customerGstin} mono />
          </div>
        </div>
      </div>

      {/* Line Items */}
      {items.length > 0 && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">Line Items ({items.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 text-xs uppercase font-semibold">
                <tr>
                  <th className="px-4 py-3 text-left">#</th>
                  <th className="px-4 py-3 text-left">Description</th>
                  <th className="px-4 py-3 text-left">HSN</th>
                  <th className="px-4 py-3 text-right">Qty</th>
                  <th className="px-4 py-3 text-right">Rate</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((item: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="px-4 py-3 text-slate-400 dark:text-slate-500">{i + 1}</td>
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">{item.name || item.description || "-"}</td>
                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400 font-mono text-xs">{item.hsn_code || "-"}</td>
                    <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">{item.qty ?? "-"}</td>
                    <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">{item.rate != null ? formatCurrency(item.rate) : "-"}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrency(item.price || item.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Amounts */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-4">
          Amounts & Tax Breakdown
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <AmountBox label="Subtotal" value={invoice.subtotal} />
          {invoice.cgst != null && <AmountBox label="CGST" value={invoice.cgst} />}
          {invoice.sgst != null && <AmountBox label="SGST" value={invoice.sgst} />}
          {invoice.igst != null && <AmountBox label="IGST" value={invoice.igst} />}
          <AmountBox label="Total Tax" value={invoice.taxAmount} />
          {invoice.discount != null && <AmountBox label="Discount" value={invoice.discount} />}
          <AmountBox label="Grand Total" value={invoice.totalAmount} highlight />
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: any;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between items-center py-1">
      <span className="text-sm font-medium text-slate-600 dark:text-slate-400">{label}</span>
      <span className={`text-sm font-semibold text-slate-900 dark:text-slate-100 ${mono ? "font-mono" : ""}`}>
        {value || "-"}
      </span>
    </div>
  );
}

function AmountBox({
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
  const display = isNaN(num) ? "-" : `₹${num.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

  return (
    <div
      className={`p-3.5 rounded-lg transition-colors ${
        highlight
          ? "bg-blue-50/80 dark:bg-blue-950/40 border-2 border-blue-200 dark:border-blue-800"
          : "bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800"
      }`}
    >
      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${highlight ? "text-blue-700 dark:text-blue-300" : "text-slate-900 dark:text-slate-100"}`}>{display}</p>
    </div>
  );
}
