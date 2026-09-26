import { describe, it, expect } from "vitest";
import { parseSchedulesCSV } from "../csvImport";

const VALID_ADDR_1 = "G" + "A".repeat(55);
const VALID_ADDR_2 = "G" + "B".repeat(55);

describe("parseSchedulesCSV", () => {
  it("reports an error for an empty file", () => {
    const { rows, headerError } = parseSchedulesCSV("");
    expect(rows).toEqual([]);
    expect(headerError).toMatch(/empty/i);
  });

  it("reports missing required columns", () => {
    const { headerError } = parseSchedulesCSV("beneficiary,amount\nGABC,100\n");
    expect(headerError).toMatch(/duration/i);
  });

  it("reports when there are no data rows", () => {
    const { rows, headerError } = parseSchedulesCSV("beneficiary,amount,duration\n");
    expect(rows).toEqual([]);
    expect(headerError).toMatch(/no data rows/i);
  });

  it("parses valid rows with no errors, defaulting cliff to 0", () => {
    const csv = `beneficiary,amount,duration\n${VALID_ADDR_1},1000,365\n`;
    const { rows, headerError } = parseSchedulesCSV(csv);
    expect(headerError).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lineNumber: 2,
      beneficiary: VALID_ADDR_1,
      amount: "1000",
      durationDays: "365",
      cliffDays: "0",
      errors: [],
    });
  });

  it("parses the optional cliff column when present", () => {
    const csv = `beneficiary,amount,duration,cliff\n${VALID_ADDR_1},1000,365,90\n`;
    const { rows } = parseSchedulesCSV(csv);
    expect(rows[0].cliffDays).toBe("90");
  });

  it("is tolerant of column order and header casing", () => {
    const csv = `Duration,Beneficiary,Amount\n365,${VALID_ADDR_1},1000\n`;
    const { rows, headerError } = parseSchedulesCSV(csv);
    expect(headerError).toBeNull();
    expect(rows[0]).toMatchObject({
      beneficiary: VALID_ADDR_1,
      amount: "1000",
      durationDays: "365",
    });
  });

  it("strips thousands separators from a quoted amount field", () => {
    const csv = `beneficiary,amount,duration\n"${VALID_ADDR_1}","1,000",365\n`;
    const { rows } = parseSchedulesCSV(csv);
    expect(rows[0].amount).toBe("1000");
  });

  it("flags an invalid beneficiary address", () => {
    const csv = `beneficiary,amount,duration\nnot-an-address,1000,365\n`;
    const { rows } = parseSchedulesCSV(csv);
    expect(rows[0].errors).toContain(
      "Beneficiary must be a valid Stellar address starting with G (56 characters)."
    );
  });

  it("flags a non-positive amount", () => {
    const csv = `beneficiary,amount,duration\n${VALID_ADDR_1},0,365\n`;
    const { rows } = parseSchedulesCSV(csv);
    expect(rows[0].errors).toContain("Amount must be a positive number.");
  });

  it("flags a duration below 1 day", () => {
    const csv = `beneficiary,amount,duration\n${VALID_ADDR_1},1000,0\n`;
    const { rows } = parseSchedulesCSV(csv);
    expect(rows[0].errors).toContain("Duration must be at least 1 day.");
  });

  it("flags a cliff longer than the duration", () => {
    const csv = `beneficiary,amount,duration,cliff\n${VALID_ADDR_1},1000,100,200\n`;
    const { rows } = parseSchedulesCSV(csv);
    expect(rows[0].errors).toContain("Cliff cannot exceed the total duration.");
  });

  it("assigns correct 1-based line numbers across multiple rows", () => {
    const csv = `beneficiary,amount,duration\n${VALID_ADDR_1},1000,365\n${VALID_ADDR_2},2000,730\n`;
    const { rows } = parseSchedulesCSV(csv);
    expect(rows.map((r) => r.lineNumber)).toEqual([2, 3]);
  });
});
