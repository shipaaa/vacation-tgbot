import { describe, expect, it } from "vitest";
import {
  computeBalances,
  calculateUsdJpyRate,
  convertAmounts,
  formatMoney,
  parseAmount,
  parseSignedAmount,
  summarizeExpenses,
  summarizeExpensesByParticipant,
} from "../src/domain/money.js";
import type { Account, StoredTransaction } from "../src/domain/types.js";

const accounts: Account[] = [
  {
    id: "cash",
    name: "Наличные",
    kind: "cash",
    currency: "JPY",
    openingBalance: 10000,
    rubRate: 0.5,
    active: true,
  },
  {
    id: "card",
    name: "Карта",
    kind: "card",
    currency: "USD",
    openingBalance: 100,
    rubRate: 77,
    active: true,
  },
];

const transactions: StoredTransaction[] = [
  {
    id: "1",
    createdAt: "2026-07-14T10:00:00.000Z",
    date: "2026-07-14",
    type: "expense",
    accountId: "cash",
    accountName: "Наличные",
    amount: 1200,
    currency: "JPY",
    purchaseAmount: 1200,
    purchaseCurrency: "JPY",
    amountRub: 600,
    amountUsd: 600 / 77,
    amountJpy: 1200,
    usdJpyRate: 154,
    usdRubRate: 77,
    jpyRubRate: 0.5,
    category: "Питание",
    description: "Рамен",
    telegramUser: "user",
    chatId: "1",
    deletedAt: "",
    moneySyncStatus: "synced",
    moneySyncError: "",
    moneySyncedAt: "2026-07-14T10:00:01.000Z",
    transferId: "",
    rowNumber: 2,
  },
  {
    id: "2",
    createdAt: "2026-07-14T11:00:00.000Z",
    date: "2026-07-14",
    type: "income",
    accountId: "cash",
    accountName: "Наличные",
    amount: 5000,
    currency: "JPY",
    purchaseAmount: 5000,
    purchaseCurrency: "JPY",
    amountRub: 2500,
    amountUsd: 2500 / 77,
    amountJpy: 5000,
    usdJpyRate: 154,
    usdRubRate: 77,
    jpyRubRate: 0.5,
    category: "Пополнение",
    description: "Банкомат",
    telegramUser: "user",
    chatId: "1",
    deletedAt: "",
    moneySyncStatus: "not_applicable",
    moneySyncError: "",
    moneySyncedAt: "",
    transferId: "",
    rowNumber: 3,
  },
  {
    id: "3",
    createdAt: "2026-07-13T11:00:00.000Z",
    date: "2026-07-13",
    type: "expense",
    accountId: "card",
    accountName: "Карта",
    amount: 10,
    currency: "USD",
    purchaseAmount: 1540,
    purchaseCurrency: "JPY",
    amountRub: 770,
    amountUsd: 10,
    amountJpy: 1540,
    usdJpyRate: 154,
    usdRubRate: 77,
    jpyRubRate: 0.5,
    category: "Транспорт",
    description: "Поезд",
    telegramUser: "user",
    chatId: "1",
    deletedAt: "",
    moneySyncStatus: "synced",
    moneySyncError: "",
    moneySyncedAt: "2026-07-13T11:00:01.000Z",
    transferId: "",
    rowNumber: 4,
  },
];

describe("parseAmount", () => {
  it("понимает русскую запись числа", () => {
    expect(parseAmount("1 250,50")).toBe(1250.5);
  });

  it("отклоняет ноль и мусор", () => {
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });

  it("понимает отрицательный и нулевой начальный остаток", () => {
    expect(parseSignedAmount("-12 500,50")).toBe(-12500.5);
    expect(parseSignedAmount("0")).toBe(0);
  });
});

describe("computeBalances", () => {
  it("учитывает начальный остаток, расходы и пополнения", () => {
    const balances = computeBalances(accounts, transactions);
    expect(balances.find((item) => item.id === "cash")?.balance).toBe(13800);
    expect(balances.find((item) => item.id === "card")?.balance).toBe(90);
  });

  it("учитывает обе стороны перевода и не считает их расходом", () => {
    const transferOut: StoredTransaction = {
      ...transactions[0]!,
      id: "4",
      type: "transfer_out",
      amount: 1000,
      purchaseAmount: 1000,
      category: "Обмен",
      transferId: "tr_1",
      rowNumber: 5,
    };
    const transferIn: StoredTransaction = {
      ...transactions[2]!,
      id: "5",
      type: "transfer_in",
      amount: 6.5,
      purchaseAmount: 6.5,
      purchaseCurrency: "USD",
      category: "Обмен",
      transferId: "tr_1",
      rowNumber: 6,
    };
    const balances = computeBalances(accounts, [...transactions, transferOut, transferIn]);
    expect(balances.find((item) => item.id === "cash")?.balance).toBe(12800);
    expect(balances.find((item) => item.id === "card")?.balance).toBe(96.5);
    expect(summarizeExpenses([...transactions, transferOut, transferIn], "JPY"))
      .toEqual(summarizeExpenses(transactions, "JPY"));
  });
});

describe("summarizeExpenses", () => {
  it("группирует расходы в базовой валюте и рублях", () => {
    expect(summarizeExpenses(transactions, "JPY", "2026-07-14")).toEqual([
      {
        label: "Питание",
        baseCurrency: "JPY",
        amountBase: 1200,
        amountRub: 600,
      },
    ]);
  });

  it("использует сохранённый курс операции для другой базовой валюты", () => {
    expect(summarizeExpenses(transactions, "USD", "2026-07-14")).toEqual([
      {
        label: "Питание",
        baseCurrency: "USD",
        amountBase: 600 / 77,
        amountRub: 600,
      },
    ]);
  });
});

describe("summarizeExpensesByParticipant", () => {
  it("группирует расходы по Telegram-участнику и периоду", () => {
    const shared: StoredTransaction[] = [
      ...transactions,
      {
        ...transactions[0]!,
        id: "participant-2",
        telegramUser: "@anna",
        purchaseAmount: 600,
        amount: 600,
        amountRub: 300,
        amountJpy: 600,
        rowNumber: 5,
      },
    ];
    expect(summarizeExpensesByParticipant(shared, "JPY", "2026-07-14")).toEqual([
      { participant: "user", count: 1, amountBase: 1200, amountRub: 600 },
      { participant: "@anna", count: 1, amountBase: 600, amountRub: 300 },
    ]);
  });
});

describe("convertAmounts", () => {
  it("сохраняет JPY-покупку, USD-списание и считает RUB", () => {
    const result = convertAmounts({
      purchaseAmount: 80250,
      purchaseCurrency: "JPY",
      accountAmount: 515.1,
      accountCurrency: "USD",
      accountRubRate: 77.065954333496,
      rates: { usdRub: 77.065954333496, jpyRub: 0.49585594377 },
    });

    expect(result.amountRub).toBeCloseTo(39696.67, 2);
    expect(result.amountUsd).toBe(515.1);
    expect(result.amountJpy).toBe(80250);
    expect(result.usdJpyRate).toBeCloseTo(155.794991, 5);
  });

  it("считает RUB и USD для наличных JPY", () => {
    const result = convertAmounts({
      purchaseAmount: 1200,
      purchaseCurrency: "JPY",
      accountAmount: 1200,
      accountCurrency: "JPY",
      accountRubRate: 0.49585594377,
      rates: { usdRub: 77.065954333496, jpyRub: 0.49585594377 },
    });

    expect(result.amountRub).toBeCloseTo(595.027, 3);
    expect(result.amountUsd).toBeCloseTo(7.721, 3);
    expect(result.amountJpy).toBe(1200);
  });

  it("сохраняет эквиваленты для сводки простой покупки в RUB", () => {
    const result = convertAmounts({
      purchaseAmount: 1940,
      purchaseCurrency: "RUB",
      accountAmount: 1940,
      accountCurrency: "RUB",
      accountRubRate: 1,
      rates: { usdRub: 77.065954333496, jpyRub: 0.49585594377 },
    });

    expect(result.amountRub).toBe(1940);
    expect(result.amountUsd).toBeCloseTo(1940 / 77.065954333496, 6);
    expect(result.amountJpy).toBeCloseTo(1940 / 0.49585594377, 6);
  });
});

describe("Telegram formatting and calculated rates", () => {
  it("использует дробность конкретной валюты", () => {
    expect(formatMoney(28830.7, "JPY")).toBe("28 831 JPY");
    expect(formatMoney(14295.88, "RUB")).toBe("14 295,88 RUB");
    expect(formatMoney(12.5, "USD")).toBe("12,5 USD");
    expect(formatMoney(12.57, "EUR")).toBe("12,57 EUR");
    expect(formatMoney(1.2345, "KWD")).toBe("1,235 KWD");
  });

  it("считает кросс-курс USD/JPY через рублёвые курсы", () => {
    expect(calculateUsdJpyRate({ usdRub: 77, jpyRub: 0.5 })).toBe(154);
    expect(calculateUsdJpyRate({ usdRub: 77, jpyRub: null })).toBeNull();
  });
});
