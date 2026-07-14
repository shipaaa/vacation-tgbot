import { describe, expect, it } from "vitest";
import { extractSpreadsheetId } from "../src/services/travelService.js";

describe("extractSpreadsheetId", () => {
  it("извлекает ID из Google Sheets URL", () => {
    expect(
      extractSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_12345/edit#gid=0",
      ),
    ).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz_12345");
  });

  it("принимает чистый ID", () => {
    expect(extractSpreadsheetId("1AbCdEfGhIjKlMnOpQrStUvWxYz_12345")).toBe(
      "1AbCdEfGhIjKlMnOpQrStUvWxYz_12345",
    );
  });
});
