import { describe, expect, it } from "vitest";
import { normalizeCurrencyCode } from "../src/domain/currency.js";

describe("normalizeCurrencyCode", () => {
  it("принимает международные коды без отдельного списка в интерфейсе", () => {
    expect(normalizeCurrencyCode("eur")).toBe("EUR");
    expect(normalizeCurrencyCode(" AED ")).toBe("AED");
    expect(normalizeCurrencyCode("KZT")).toBe("KZT");
  });

  it("понимает распространённые русские названия и символы", () => {
    expect(normalizeCurrencyCode("евро")).toBe("EUR");
    expect(normalizeCurrencyCode("тенге")).toBe("KZT");
    expect(normalizeCurrencyCode("£")).toBe("GBP");
    expect(normalizeCurrencyCode("$")).toBe("USD");
  });

  it("отклоняет неизвестные и невалютные значения", () => {
    expect(normalizeCurrencyCode("ABC")).toBeNull();
    expect(normalizeCurrencyCode("деньги")).toBeNull();
  });
});
