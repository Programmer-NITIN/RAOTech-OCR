"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Monitor,
  PlugZap,
  RefreshCw,
  Save,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  fetchDevices,
  fetchSyncStatus,
  formatTallyDate,
  relativeTime,
  useConnectorStatus,
  type ConnectorDevice,
  type TallyCompany,
  type TallyConnection as Connection,
} from "@/components/tallyClient";

/**
 * The human side of the connector protocol.
 *
 * Three things have to be true before a voucher can reach Tally, and this page
 * is where each one is established: a paired desktop device, a named company,
 * and a Tally that is actually answering on its HTTP gateway. When one of them
 * is false, everything downstream queues — so each section says plainly which
 * of the three it is reporting on.
 */

/** A change in either signature means the connector has answered our job. */
function companySignature(c: Connection | null): string {
  const co = c?.company;
  return co ? `${co.status}|${co.lastSyncedAt ?? ""}|${co.ledgerCount}` : "none";
}
function deviceSignature(c: Connection | null): string {
  const d = c?.device;
  return d ? `${d.lastSeenAt ?? ""}|${d.tallyReachable}|${d.tallyMessage ?? ""}` : "none";
}

type Watch = { kind: "master" | "test"; jobId: string; baseline: string; deadline: number };

export default function TallyConnection({ clientName }: { clientName?: string }) {
  const { toast } = useToast();
  const { data, loading, refresh, setData } = useConnectorStatus({ intervalMs: 15_000 });
  const [devices, setDevices] = useState<ConnectorDevice[]>([]);
  const [watch, setWatch] = useState<Watch | null>(null);
  const [busy, setBusy] = useState<"pair" | "save" | "master" | "test" | "revoke" | null>(null);

  const loadDevices = useCallback(async (alive: () => boolean = () => true) => {
    try {
      const list = await fetchDevices();
      if (alive()) setDevices(list);
    } catch {
      // The connection payload already carries enough to render the panel.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    // The device list is owned by the server — and by whoever is at the Tally
    // machine. Reading it on mount is a subscription, not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDevices(() => alive);
    return () => {
      alive = false;
    };
  }, [loadDevices]);

  // A job is only "finished" when the connector has written something back —
  // either the job row reaching a terminal state, or the payload it updates
  // visibly changing. Whichever arrives first ends the wait.
  useEffect(() => {
    if (!watch) return;
    let alive = true;

    function finish(next: Connection | null, jobError?: string | null) {
      setWatch(null);
      setBusy(null);
      if (jobError) {
        toast(jobError, "error");
        return;
      }
      if (watch!.kind === "master") {
        const status = next?.company?.status;
        if (status === "ERROR") toast("Master sync failed — see the diagnostics below.", "error");
        else toast(`Read ${next?.company?.ledgerCount ?? 0} ledgers from Tally.`, "success");
      } else {
        const d = next?.device;
        toast(
          d?.tallyMessage || (d?.tallyReachable ? "Tally answered." : "Tally did not answer."),
          d?.tallyReachable ? "success" : "error"
        );
      }
    }

    const timer = window.setInterval(async () => {
      const [next, status] = await Promise.all([
        refresh(),
        fetchSyncStatus([], watch.jobId).catch(() => null),
      ]);
      if (!alive) return;

      const job = status?.job;
      if (job && (job.state === "DONE" || job.state === "FAILED" || job.state === "CANCELLED")) {
        finish(next, job.state === "DONE" ? null : job.error || "The connector could not run the job.");
        return;
      }

      const now = watch.kind === "master" ? companySignature(next) : deviceSignature(next);
      if (now !== watch.baseline) {
        finish(next);
        return;
      }
      if (Date.now() > watch.deadline) {
        setWatch(null);
        setBusy(null);
        toast("Still queued — the connector will run it the next time it polls.", "info");
      }
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [watch, refresh, toast]);

  async function post(url: string, kind: "master" | "test") {
    setBusy(kind);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body.error || `Request failed (${res.status})`, "error");
        setBusy(null);
        return;
      }
      setWatch({
        kind,
        jobId: body.jobId,
        baseline: kind === "master" ? companySignature(data) : deviceSignature(data),
        deadline: Date.now() + (kind === "master" ? 180_000 : 60_000),
      });
      await refresh();
    } catch {
      toast("Could not reach the server.", "error");
      setBusy(null);
    }
  }

  const pairedDevice = devices.find((d) => !d.revokedAt) ?? null;

  return (
    <div className="p-6 md:p-10 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/settings"
            className="mb-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Ledgers &amp; Rules
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">Tally Connection</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-zinc-400">
            {clientName ? `${clientName} · ` : ""}Pair the desktop connector, name the company in
            Tally, and check the gateway
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void refresh(); void loadDevices(); }}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      {loading && !data ? (
        <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-sm text-gray-500 dark:text-zinc-400 shadow-sm">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Reading the connection…
        </div>
      ) : (
        <>
          <DeviceSection
            device={pairedDevice}
            summary={data?.device ?? null}
            connectorOnline={data?.connectorOnline ?? false}
            busy={busy}
            setBusy={setBusy}
            onChanged={async () => {
              await Promise.all([refresh(), loadDevices()]);
            }}
          />

          <CompanySection
            company={data?.company ?? null}
            paired={!!pairedDevice}
            busy={busy}
            setBusy={setBusy}
            onSaved={(company) =>
              setData((prev) => (prev ? { ...prev, company } : { company, device: null, connectorOnline: false }))
            }
            onSyncMaster={() => post("/api/tally/sync-master", "master")}
            onTestConnection={() => post("/api/tally/test-connection", "test")}
          />

          {data?.device && <Diagnostics device={data.device} educationMode={data.company?.educationMode} />}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- device */

function DeviceSection({
  device,
  summary,
  connectorOnline,
  busy,
  setBusy,
  onChanged,
}: {
  device: ConnectorDevice | null;
  summary: Connection["device"];
  connectorOnline: boolean;
  busy: string | null;
  setBusy: (b: "pair" | "save" | "master" | "test" | "revoke" | null) => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  // The code is live for ten minutes; showing the countdown is the difference
  // between "type this in" and "type this in before it stops working".
  useEffect(() => {
    if (!code) return;
    function tick() {
      const left = Math.round((new Date(code!.expiresAt).getTime() - Date.now()) / 1000);
      setSecondsLeft(Math.max(0, left));
      if (left <= 0) setCode(null);
    }
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  // While a code is on screen the desktop may claim it at any moment, and the
  // only way we hear about it is by asking.
  useEffect(() => {
    if (!code) return;
    let alive = true;
    const timer = window.setInterval(async () => {
      let list: ConnectorDevice[];
      try {
        list = await fetchDevices();
      } catch {
        return;
      }
      if (!alive) return;
      if (list.some((d) => !d.revokedAt)) {
        setCode(null);
        void changedRef.current();
      }
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [code]);

  async function pair() {
    setBusy("pair");
    try {
      const res = await fetch("/api/connector/devices/pair-code", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body.error || "Could not create a pairing code", "error");
        return;
      }
      setCode({ code: body.code, expiresAt: body.expiresAt });
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!device) return;
    setBusy("revoke");
    try {
      const res = await fetch(`/api/connector/devices/${device.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error || "Could not revoke the device", "error");
        return;
      }
      setConfirmRevoke(false);
      toast("Device revoked. It will stop polling on its next request.", "success");
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  const host = device?.tallyHost ?? summary?.tallyHost ?? "localhost";
  const port = device?.tallyPort ?? summary?.tallyPort ?? 9000;

  return (
    <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-800/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-gray-500 dark:text-zinc-400" />
          <h2 className="font-semibold text-slate-900 dark:text-zinc-100">Connector device</h2>
        </div>
        {device &&
          (connectorOnline ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/60 px-2 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" /> Online
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-950/60 px-2 py-1 text-xs font-bold text-amber-700 dark:text-amber-300">
              <PlugZap className="h-3 w-3" /> Offline
            </span>
          ))}
      </header>

      {device ? (
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <dl className="space-y-2 text-sm">
            <Row label="Device" value={device.deviceName} />
            <Row label="Last seen" value={relativeTime(device.lastSeenAt ?? summary?.lastSeenAt)} />
            <Row label="Connector version" value={device.appVersion || "—"} />
            <Row label="Tally gateway" value={`${host}:${port}`} mono />
          </dl>
          <div className="flex flex-col items-start justify-between gap-3 md:items-end">
            <p className="text-xs text-gray-500 dark:text-zinc-400 md:text-right">
              Revoking invalidates this machine&apos;s token. The desktop stops polling on its next
              request and has to be paired again; nothing already in Tally is affected.
            </p>
            <Button variant="outline" size="sm" onClick={() => setConfirmRevoke(true)}>
              Revoke device
            </Button>
          </div>
        </div>
      ) : code ? (
        <div className="space-y-4 p-4">
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800/50 px-4 py-6 text-center">
            <p className="font-mono text-4xl font-bold tracking-[0.3em] text-gray-900 dark:text-zinc-100">{code.code}</p>
            <p className="mt-2 text-xs text-gray-500 dark:text-zinc-400">
              Expires in{" "}
              <span className="font-medium text-gray-700 dark:text-zinc-300">
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
              </span>
            </p>
          </div>
          <p className="text-sm text-gray-600 dark:text-zinc-300">
            Open the Rao-Tech connector on the machine running Tally and enter this code. This page
            will switch over on its own the moment it is claimed.
          </p>
          <p className="flex items-center gap-2 text-xs text-gray-400 dark:text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for the connector…
          </p>
        </div>
      ) : (
        <div className="space-y-3 p-4">
          <p className="text-sm text-gray-600 dark:text-zinc-300">
            No device is paired. Tally listens only on the accountant&apos;s own machine, so a small
            desktop connector runs there and polls this workspace for work — nothing dials in.
          </p>
          <Button size="sm" onClick={pair} disabled={busy === "pair"}>
            {busy === "pair" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Pair a device
          </Button>
        </div>
      )}

      {confirmRevoke && device && (
        <ConfirmDialog
          title={`Revoke ${device.deviceName}?`}
          body={
            <>
              The connector on that machine will get a 401 on its next poll and stop. Queued
              vouchers stay queued until a device is paired again. Vouchers already in Tally are
              untouched.
            </>
          }
          confirmLabel={busy === "revoke" ? "Revoking…" : "Revoke device"}
          busy={busy === "revoke"}
          onConfirm={revoke}
          onCancel={() => setConfirmRevoke(false)}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------ company */

const STATUS_TONE: Record<string, string> = {
  READY: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  SYNCING: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  ERROR: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  UNSYNCED: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function CompanySection({
  company,
  paired,
  busy,
  setBusy,
  onSaved,
  onSyncMaster,
  onTestConnection,
}: {
  company: TallyCompany | null;
  paired: boolean;
  busy: string | null;
  setBusy: (b: "pair" | "save" | "master" | "test" | "revoke" | null) => void;
  onSaved: (company: TallyCompany) => void;
  onSyncMaster: () => void;
  onTestConnection: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(company?.companyName ?? "");
  const touched = useRef(false);

  // Polling must not overwrite what the user is halfway through typing.
  useEffect(() => {
    if (!touched.current) setName(company?.companyName ?? "");
  }, [company?.companyName]);

  async function save() {
    const companyName = name.trim();
    if (!companyName) return;
    setBusy("save");
    try {
      const res = await fetch("/api/tally/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body.error || "Could not save the company", "error");
        return;
      }
      touched.current = false;
      onSaved(body.company);
      toast("Company saved. Run Sync Master to read its ledgers.", "success");
    } finally {
      setBusy(null);
    }
  }

  const fyStart = formatTallyDate(company?.fyStart);
  const fyEnd = formatTallyDate(company?.fyEnd);
  const dirty = touched.current && name.trim() !== (company?.companyName ?? "");

  return (
    <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-800/40 px-4 py-3">
        <h2 className="font-semibold text-slate-900 dark:text-zinc-100">Tally company</h2>
        {company && (
          <span
            className={`rounded-full px-2 py-1 text-xs font-bold ${STATUS_TONE[company.status] ?? STATUS_TONE.UNSYNCED}`}
          >
            {company.status}
          </span>
        )}
      </header>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="tally-company" className="text-slate-700 dark:text-zinc-300">Company name, exactly as it appears in Tally</Label>
            <Input
              id="tally-company"
              value={name}
              placeholder="RAOTECH TRADERS"
              className="dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100 dark:placeholder-zinc-500"
              onChange={(e) => {
                touched.current = true;
                setName(e.target.value);
              }}
            />
            <p className="text-xs text-gray-500 dark:text-zinc-400">
              Tally addresses companies by name. A spelling that differs by so much as a double
              space is a different company as far as the import is concerned.
            </p>
          </div>
          <Button size="sm" onClick={save} disabled={busy === "save" || !name.trim() || (!!company && !dirty)}>
            {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save
          </Button>
        </div>

        {company && (
          <dl className="grid gap-2 rounded-lg border border-slate-200 dark:border-zinc-800 bg-gray-50/60 dark:bg-zinc-800/30 p-3 text-sm sm:grid-cols-3">
            <Row label="Ledgers" value={String(company.ledgerCount)} />
            <Row label="Last synced" value={relativeTime(company.lastSyncedAt)} />
            <Row
              label="Financial year"
              value={fyStart && fyEnd ? `${fyStart} — ${fyEnd}` : "unknown until first sync"}
            />
          </dl>
        )}

        {company?.educationMode && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Tally is running in education mode. It rejects imports with an <em>empty</em> reason,
              so a push will fail without saying why. Activate a licence before posting.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="bg-[#0b6b3a] hover:bg-[#0a5c32] text-white"
            disabled={!company || !paired || busy === "master"}
            onClick={onSyncMaster}
          >
            {busy === "master" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Sync Master
          </Button>
          <Button size="sm" variant="outline" disabled={!paired || busy === "test"} onClick={onTestConnection}>
            {busy === "test" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wifi className="mr-2 h-4 w-4" />}
            Test Connection
          </Button>
          <p className="text-xs text-gray-500 dark:text-zinc-400">
            {paired
              ? "Both are queued for the connector; it answers on its next poll."
              : "Pair a device first — these run on the Tally machine, not here."}
          </p>
        </div>

        {company?.status !== "READY" && (
          <p className="text-xs text-gray-500 dark:text-zinc-400">
            Vouchers cannot be pushed until master data has been read at least once: Tally matches
            ledgers by name, and the workspace has to know the names it will be matched against.
          </p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------- diagnostics */

function Diagnostics({
  device,
  educationMode,
}: {
  device: NonNullable<Connection["device"]>;
  educationMode?: boolean;
}) {
  const reachable = device.tallyReachable === true;
  const port = device.tallyPort ?? 9000;

  return (
    <section className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
      <header className="border-b border-slate-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-800/40 px-4 py-3">
        <h2 className="font-semibold text-slate-900 dark:text-zinc-100">Diagnostics</h2>
      </header>
      <div className="space-y-3 p-4 text-sm">
        <div className="flex items-start gap-2">
          {reachable ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          )}
          <div className="min-w-0 flex-1">
            <p className={reachable ? "font-medium text-emerald-800 dark:text-emerald-300" : "font-medium text-red-800 dark:text-red-300"}>
              {reachable ? "Tally is answering" : "The connector cannot reach Tally"}
            </p>
            {device.tallyMessage && (
              // Verbatim. Whatever the desktop saw is more useful than our summary of it.
              <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 p-2 font-mono text-xs text-slate-800 dark:text-zinc-200">
                {device.tallyMessage}
              </pre>
            )}
          </div>
        </div>

        {!reachable && (
          <div className="space-y-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 p-3 text-red-900 dark:text-red-300">
            <p className="font-semibold">On the Tally machine</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                <span className="font-mono text-xs">F1 → Settings → Connectivity → Client/Server Configuration</span>
              </li>
              <li>
                TallyPrime acts as <strong>Both</strong>
              </li>
              <li>
                Enable ODBC <strong>Yes</strong>
              </li>
              <li>
                Port <strong>{port}</strong> — it must match the port the connector is configured with
              </li>
              <li>Restart Tally</li>
            </ol>
            <p className="pt-1">
              Then confirm <span className="font-mono text-xs">tally.exe</span> is running{" "}
              <strong>with the company loaded</strong>. A running{" "}
              <span className="font-mono text-xs">tallygatewayserver.exe</span> is a different
              component and is not enough on its own — the gateway answers only while the
              application has the company open.
            </p>
          </div>
        )}

        {educationMode && (
          <p className="text-xs text-gray-500 dark:text-zinc-400">
            Education mode is also reported here because its rejections come back blank; if a push
            fails with no reason at all, check the licence first.
          </p>
        )}
      </div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-400 dark:text-zinc-400">{label}</dt>
      <dd className={`text-right text-gray-900 dark:text-zinc-100 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
