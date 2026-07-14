import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Account, StoredTransaction, TravelTransaction } from "../src/domain/types.js";
import { TravelService } from "../src/services/travelService.js";

const config: AppConfig = {
  telegramBotToken: "test",
  stateFile: "unused",
  defaultTimezone: "Asia/Tokyo",
  allowedTelegramUserIds: new Set(),
  openaiTextModel: "gpt-5-mini",
  openaiTranscribeModel: "gpt-4o-mini-transcribe",
  voiceMaxSeconds: 120,
};

describe("TravelService transfers", () => {
  it("записывает, показывает и атомарно отменяет обе стороны обмена", async () => {
    const accounts: Account[] = [
      {
        id: "usd",
        name: "Карта USD",
        kind: "card",
        currency: "USD",
        openingBalance: 1000,
        rubRate: 77,
        active: true,
      },
      {
        id: "jpy",
        name: "Наличные JPY",
        kind: "cash",
        currency: "JPY",
        openingBalance: 0,
        rubRate: 0.5,
        active: true,
      },
    ];
    const transactions: StoredTransaction[] = [];
    const gateway = {
      getAccounts: async () => accounts,
      getSettings: async () => new Map([
        ["timezone", "Asia/Tokyo"],
        ["base_currency", "JPY"],
        ["usd_rub_rate", "77"],
        ["jpy_rub_rate", "0.5"],
      ]),
      getTransactions: async () => transactions,
      appendTransferTransactions: async (
        _spreadsheetId: string,
        pair: readonly [TravelTransaction, TravelTransaction],
      ) => {
        transactions.push(
          { ...pair[0], rowNumber: transactions.length + 5 },
          { ...pair[1], rowNumber: transactions.length + 6 },
        );
      },
      markTransactionsDeleted: async (
        _spreadsheetId: string,
        pair: StoredTransaction[],
        deletedAt: string,
      ) => {
        for (const transaction of pair) transaction.deletedAt = deletedAt;
      },
    };
    const stateStore = {
      getConnection: async () => ({
        spreadsheetId: "sheet",
        title: "Япония",
        connectedAt: "2026-07-14T00:00:00.000Z",
      }),
    };
    const service = new TravelService(gateway as never, stateStore as never, config);

    const transfer = await service.recordTransfer({
      chatId: "42",
      sourceAccountId: "usd",
      destinationAccountId: "jpy",
      sourceAmount: 100,
      destinationAmount: 15500,
      description: "Обмен в банкомате",
      telegramUser: "@traveler",
    });

    expect(transfer.source.transferId).toBe(transfer.destination.transferId);
    expect((await service.getRecentTransactions("42"))).toHaveLength(1);
    expect((await service.getSummary("42", false)).lines).toEqual([]);
    expect((await service.getBalances("42")).map((item) => item.balance)).toEqual([900, 15500]);

    await service.undoTransaction("42", transfer.source.id);
    expect(transactions.every((transaction) => transaction.deletedAt)).toBe(true);
    expect((await service.getBalances("42")).map((item) => item.balance)).toEqual([1000, 0]);
  });
});

describe("TravelService dashboard and digest", () => {
  it("кеширует агрегированный dashboard и сбрасывает кеш после настройки бюджета", async () => {
    let reads = 0;
    const settings = new Map([
      ["timezone", "Asia/Tokyo"],
      ["base_currency", "JPY"],
      ["daily_budget", "5000"],
      ["category_budgets_json", JSON.stringify({ Питание: 20000 })],
    ]);
    const gateway = {
      getAccounts: async () => { reads += 1; return []; },
      getTransactions: async () => [],
      getSettings: async () => settings,
      setSetting: async (_id: string, key: string, value: string) => { settings.set(key, value); },
    };
    const stateStore = {
      getConnection: async () => ({
        spreadsheetId: "sheet",
        title: "Япония",
        connectedAt: "2026-07-14T00:00:00.000Z",
      }),
    };
    const service = new TravelService(gateway as never, stateStore as never, config);

    const first = await service.getDashboard("42");
    const second = await service.getDashboard("42");
    expect(second).toBe(first);
    expect(reads).toBe(1);
    expect(first.budgets.daily?.limit).toBe(5000);

    await service.setDailyBudget("42", 7000);
    expect((await service.getDashboard("42")).budgets.daily?.limit).toBe(7000);
    expect(reads).toBe(2);
  });

  it("готовит digest один раз после заданного локального времени", async () => {
    let lastSent: string | null = null;
    const settings = new Map([
      ["timezone", "Asia/Tokyo"],
      ["base_currency", "JPY"],
      ["daily_digest_enabled", "true"],
      ["daily_digest_time", "21:00"],
    ]);
    const connection = {
      spreadsheetId: "sheet",
      title: "Япония",
      connectedAt: "2026-07-14T00:00:00.000Z",
    };
    const gateway = {
      getAccounts: async () => [],
      getTransactions: async () => [],
      getSettings: async () => settings,
    };
    const stateStore = {
      getConnection: async () => connection,
      getActiveChatConnections: async () => [{ chatId: "42", connection }],
      getDigestLastSent: async () => lastSent,
      setDigestLastSent: async (_chat: string, _sheet: string, date: string) => { lastSent = date; },
    };
    const service = new TravelService(gateway as never, stateStore as never, config);
    const now = new Date("2026-07-14T12:30:00.000Z");

    const [delivery] = await service.getDueDigests(now);
    expect(delivery?.localDate).toBe("2026-07-14");
    await service.markDigestSent(delivery!);
    expect(await service.getDueDigests(now)).toEqual([]);
  });
});
