/**
 * A reference connector, in ~150 lines.
 *
 * Speaks the same protocol as the Go agent: pair, heartbeat, long-poll, post
 * result. Its purpose is diagnostic — when an end-to-end push fails, running
 * this tells you immediately whether the fault is in the cloud or in the
 * desktop binary, which is otherwise a genuinely hard thing to work out.
 *
 * It is also the executable form of `tally-dev-protocol.md`: if this and the Go
 * runner disagree, one of them is wrong about the contract.
 *
 *   npx tsx scripts/ref-connector.mts pair FXGX-BY4E
 *   npx tsx scripts/ref-connector.mts run --once
 */
import fs from "node:fs";
import path from "node:path";
import { pushToTally, pingTally, type TallyGateway } from "../src/lib/tally/connector";

const CLOUD = (process.env.CLOUD_URL || "http://localhost:3000").trim();
const STATE = path.join(process.cwd(), ".ref-connector.json");
const gateway: TallyGateway = {
  host: process.env.TALLY_HOST || "localhost",
  port: Number(process.env.TALLY_PORT || 9000),
  timeoutMs: 60_000,
};

interface State {
  token: string;
  deviceId: string;
}

const loadState = (): State =>
  JSON.parse(fs.readFileSync(STATE, "utf8")) as State;

async function pair(code: string) {
  const res = await fetch(`${CLOUD}/api/connector/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      deviceName: "ref-connector",
      machineId: "ref-connector-machine",
      appVersion: "ref-0.1.0",
      osVersion: `${process.platform} ${process.arch}`,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pair failed ${res.status}: ${JSON.stringify(body)}`);
  fs.writeFileSync(STATE, JSON.stringify({ token: body.token, deviceId: body.deviceId }), {
    mode: 0o600,
  });
  console.log(`paired as ${body.deviceName} (${body.deviceId}) for ${body.userEmail}`);
  console.log(`token stored in ${STATE}`);
}

async function heartbeat(token: string) {
  const ping = await pingTally(gateway);
  await fetch(`${CLOUD}/api/connector/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      tallyReachable: ping.reachable,
      tallyMessage: ping.message,
      tallyHost: gateway.host,
      tallyPort: gateway.port,
      appVersion: "ref-0.1.0",
    }),
  });
  return ping;
}

/** Mirrors internal/tally.ImportResult, which is what the protocol's `tally` object is. */
function counters(r: Awaited<ReturnType<typeof pushToTally>>) {
  return {
    created: r.created,
    altered: r.altered,
    deleted: r.deleted,
    ignored: r.ignored,
    combined: r.combined,
    cancelled: r.cancelled,
    errors: r.errors,
    exceptions: r.exceptions,
    // A number, matching the Go agent's `LastVchID int`. The parser hands back
    // a string because the id is opaque to it; the wire format is not.
    lastVchId: Number(r.lastVoucherId ?? 0),
    lastMId: 0,
    lineErrors: r.lineErrors,
  };
}

const succeeded = (c: ReturnType<typeof counters>) =>
  c.errors === 0 && c.exceptions === 0 && c.lineErrors.length === 0;


/** POST a raw envelope and return the body, for the read-side requests. */
async function exportXml(body: string): Promise<string> {
  const res = await fetch(`http://${gateway.host}:${gateway.port}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml;charset=utf-8" },
    body,
  });
  return res.text();
}

function collection(id: string, type: string, fields: string[], company?: string) {
  const vars = company
    ? `<STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES>`
    : "<STATICVARIABLES></STATICVARIABLES>";
  return (
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>` +
    `<TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC>${vars}` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>` +
    fields.map((f) => `<NATIVEMETHOD>${f}</NATIVEMETHOD>`).join("") +
    `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`
  );
}

const tag = (block: string, name: string) =>
  block.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1]?.trim() ?? "";

/**
 * Tally emits `&#4;` in <PARENT> on its own reserved objects — a legal-looking
 * character reference to a code point XML forbids, which makes a real parser
 * reject the whole document. Strip them the way the Go client's sanitize() does.
 */
const clean = (s: string) => s.replace(/&#(?:[0-8]|1[1-2]|1[4-9]|2\d|3[01]);/g, "");

const unescape = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

async function readCompanies() {
  const xml = clean(await exportXml(collection("RefCo", "Company", ["Name", "BooksFrom", "StartingFrom", "EndingAt", "GUID"])));
  return [...xml.matchAll(/<COMPANY( [^>]*)?>([\s\S]*?)<\/COMPANY>/g)].map((m) => ({
    name: unescape(tag(m[2], "NAME")),
    startingFrom: tag(m[2], "STARTINGFROM"),
    endingAt: tag(m[2], "ENDINGAT"),
    guid: tag(m[2], "GUID"),
  }));
}

async function readLedgers(company: string) {
  const xml = clean(
    await exportXml(collection("RefLed", "Ledger", ["Name", "Parent", "GUID"], company))
  );
  return [...xml.matchAll(/<LEDGER( [^>]*)?>([\s\S]*?)<\/LEDGER>/g)].map((m) => {
    // The name is the NAME *attribute*, not a child element — parsing for a
    // top-level <NAME> child silently yields empty names.
    const attrs = m[1] ?? "";
    const name = unescape(attrs.match(/\sNAME="([^"]*)"/)?.[1] ?? "");
    const reserved = (attrs.match(/RESERVEDNAME="([^"]*)"/)?.[1] ?? "") !== "";
    return {
      name,
      parent: unescape(tag(m[2], "PARENT")),
      guid: tag(m[2], "GUID"),
      reserved,
    };
  });
}

async function handle(job: {
  id: string;
  kind: string;
  companyName: string | null;
  payload: Record<string, unknown>;
}) {
  const started = Date.now();

  if (job.kind === "PING") {
    const ping = await pingTally(gateway);
    return { ok: ping.reachable, error: ping.reachable ? null : ping.message };
  }

  if (job.kind === "MASTER_PULL") {
    const company = job.companyName ?? String(job.payload.companyName ?? "");
    const [companies, ledgers] = await Promise.all([
      readCompanies(),
      company ? readLedgers(company) : Promise.resolve([]),
    ]);
    console.log(`    ${companies.length} company(ies), ${ledgers.length} ledger(s)`);
    return { ok: true, companies, ledgers, durationMs: Date.now() - started };
  }

  if (job.kind === "MASTER_CREATE") {
    const r = await pushToTally(String(job.payload.xml ?? ""), gateway);
    const c = counters(r);
    return {
      ok: succeeded(c),
      tally: c,
      error: succeeded(c) ? null : c.lineErrors.join(" | ") || "rejected without a reason",
    };
  }

  if (job.kind === "VOUCHER_PUSH" || job.kind === "VOUCHER_DELETE") {
    const vouchers = (job.payload.vouchers ?? []) as {
      voucherId: string;
      xml: string;
    }[];

    // One envelope per voucher. Tally's counters are aggregate and its
    // LINEERROR strings carry no voucher identity, so a batch cannot tell you
    // which one failed — looping is what makes a per-voucher status truthful.
    const results = [];
    for (const v of vouchers) {
      const r = await pushToTally(v.xml, gateway);
      const c = counters(r);
      const ok = succeeded(c);
      results.push({
        voucherId: v.voucherId,
        ok,
        tally: c,
        error: ok ? null : c.lineErrors.join(" | ") || null,
      });
      console.log(`    ${ok ? "OK  " : "FAIL"} ${v.voucherId}  ${c.lineErrors.join(" | ")}`);
    }
    return { ok: results.every((r) => r.ok), results, durationMs: Date.now() - started };
  }

  return { ok: false, error: `unsupported job kind ${job.kind}` };
}

async function run(once: boolean) {
  const { token } = loadState();
  const ping = await heartbeat(token);
  console.log(`tally: ${ping.reachable ? "reachable" : "UNREACHABLE"} — ${ping.message}`);

  for (;;) {
    const res = await fetch(`${CLOUD}/api/connector/jobs?wait=${once ? 2 : 25}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) throw new Error("401 — device revoked or token invalid; re-pair");
    const { job } = await res.json();

    if (!job) {
      console.log("no work");
      if (once) return;
      continue;
    }

    console.log(`job ${job.kind} ${job.id}`);
    let body: Record<string, unknown>;
    try {
      body = await handle(job);
    } catch (err) {
      // Tally unreachable is a job-level failure with NO results array — the
      // cloud then fails every voucher the payload carried. Synthesising
      // per-voucher errors here would record Tally as having rejected vouchers
      // it never saw.
      body = { ok: false, error: (err as Error).message };
    }

    const report = await fetch(`${CLOUD}/api/connector/jobs/${job.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    console.log(`  reported: ${report.status} ${JSON.stringify(await report.json())}`);
    if (once) return;
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "pair" && arg) await pair(arg);
else if (cmd === "run") await run(process.argv.includes("--once"));
else {
  console.error("usage: ref-connector.mts pair <CODE> | run [--once]");
  process.exit(1);
}
