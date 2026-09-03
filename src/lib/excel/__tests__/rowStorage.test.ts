import { describe, it, expect } from "vitest";
import { encodeSheet, decodeSheet } from "../rowStorage";
import type { ParsedSheet } from "../types";

describe("rowStorage", () => {
  it("encodes and decodes date cells without NUL bytes", () => {
    const originalDate = new Date("2026-04-01T00:00:00.000Z");
    const sheet: ParsedSheet = {
      sheetName: "Sheet1",
      headerRowIndex: 0,
      headers: ["Invoice Date", "Customer"],
      rows: [[originalDate, "ACME Corp"]],
      droppedRowIndexes: [],
      totalRowsScanned: 1,
    };

    const encoded = encodeSheet(sheet);
    const jsonString = JSON.stringify(encoded);

    // PostgreSQL JSONB rejects NUL bytes (\u0000) with code 22P05
    expect(jsonString.includes("\\u0000")).toBe(false);
    expect(jsonString.includes("\0")).toBe(false);

    const decoded = decodeSheet(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.rows[0][0]).toBeInstanceOf(Date);
    expect((decoded?.rows[0][0] as Date).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(decoded?.rows[0][1]).toBe("ACME Corp");
  });
});
