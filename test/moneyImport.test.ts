import { describe, expect, it } from "vitest";
import {
  MANUAL_MONEY_USER,
  manualMoneyTransactionChanged,
  parseManualMoneyRow,
  transactionIdFromMoneyNote,
} from "../src/domain/moneyImport.js";
import type { Account } from "../src/domain/types.js";

const accounts: Account[] = [
  {
    id: "cash-jpy",
    name: "Наличные JPY",
    kind: "cash",
    currency: "JPY",
    openingBalance: 100_000,
    rubRate: 0.5,
    active: true,
  },
  {
    id: "card-rub",
    name: "Карта RU",
    kind: "card",
    currency: "RUB",
    openingBalance: 50_000,
    rubRate: 1,
    active: true,
  },
  {
    id: "card-usd",
    name: "Карта CRY",
    kind: "card",
    currency: "USD",
    openingBalance: 1_000,
    rubRate: 80,
    active: true,
  },
];

describe("manual Money import", () => {
  it("создаёт расход из оплаченной ручной строки", () => {
    const serial = Date.UTC(2026, 6, 14) / 86_400_000 + 25_569;
    const parsed = parseManualMoneyRow({
      values: ["Рамен", "Питание", "Оплачено", "Наличные", 600, 7.5, 1_200, 160, 80, serial, ""],
      accounts,
      chatId: "42",
      transactionId: "money_123",
      now: "2026-07-14T18:00:00.000Z",
    });

    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") return;
    expect(parsed.transaction).toMatchObject({
      id: "money_123",
      date: "14.07.2026",
      accountId: "cash-jpy",
      amount: 1_200,
      currency: "JPY",
      amountRub: 600,
      category: "Питание",
      description: "Рамен",
      telegramUser: MANUAL_MONEY_USER,
      chatId: "42",
      moneySyncStatus: "synced",
    });
  });

  it("не импортирует неоплаченную строку", () => {
    expect(parseManualMoneyRow({
      values: ["Отель", "Проживание", "Запланировано"],
      accounts,
      chatId: "42",
      transactionId: "money_124",
    })).toEqual({ status: "ignored" });
  });

  it("не угадывает счёт при неоднозначных наличных", () => {
    const parsed = parseManualMoneyRow({
      values: ["Кофе", "Питание", "Оплачено", "Наличные", 500, 6.25, 1_000, 160, 80, "14.07.2026"],
      accounts: [...accounts, { ...accounts[0]!, id: "cash-2", name: "Запасные наличные" }],
      chatId: "42",
      transactionId: "money_125",
    });
    expect(parsed.status).toBe("unresolved");
  });

  it("читает технический ID и замечает изменение строки", () => {
    expect(transactionIdFromMoneyNote("Telegram money_123 · manual Money · Наличные JPY"))
      .toBe("money_123");
    const parsed = parseManualMoneyRow({
      values: ["Рамен", "Питание", "Оплачено", "Карта RU", 600, 7.5, 1_200, 160, 80, "14.07.2026"],
      accounts,
      chatId: "42",
      transactionId: "money_123",
    });
    if (parsed.status !== "ready") throw new Error("Строка должна распознаться");
    expect(manualMoneyTransactionChanged(
      parsed.transaction,
      { ...parsed.transaction, description: "Ужин" },
    )).toBe(true);
  });
});
