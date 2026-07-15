import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Account, StoredTransaction, TravelTransaction } from "../src/domain/types.js";
import { TravelService } from "../src/services/travelService.js";

const config: AppConfig = {
  telegramBotToken: "test",
  stateFile: "unused",
  defaultTimezone: "Asia/Tokyo",
  allowedTelegramUserIds: new Set(),
  allowPublicAccess: true,
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
        return pair;
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
      syncManualMoneyTransactions: async () => ({
        imported: 0,
        updated: 0,
        deleted: 0,
        unresolved: 0,
      }),
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
    expect(delivery?.localDate).toBe("14.07.2026");
    await service.markDigestSent(delivery!);
    expect(await service.getDueDigests(now)).toEqual([]);

    lastSent = "2026-07-14";
    expect(await service.getDueDigests(now)).toEqual([]);
  });

  it("объединяет частые проверки ручного Money в один API-запрос", async () => {
    let syncCalls = 0;
    const result = { imported: 0, updated: 0, deleted: 0, unresolved: 0 };
    const gateway = {
      syncManualMoneyTransactions: async () => {
        syncCalls += 1;
        return result;
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

    await Promise.all([service.syncManualMoney("42"), service.syncManualMoney("42")]);

    expect(syncCalls).toBe(1);
  });

  it("возвращает безопасную эксплуатационную диагностику без spreadsheet ID", async () => {
    const gateway = {
      getAccounts: async () => [],
      getTransactions: async () => [],
      getSettings: async () => new Map(),
    };
    const stateStore = {
      getConnection: async () => ({
        spreadsheetId: "secret-sheet-id",
        title: "Япония",
        connectedAt: "2026-07-14T00:00:00.000Z",
      }),
    };
    const service = new TravelService(gateway as never, stateStore as never, config);

    const status = await service.getSystemStatus("42");

    expect(status).toMatchObject({
      connectionTitle: "Япония",
      accounts: 0,
      activeTransactions: 0,
      pendingMoneySync: 0,
      failedMoneySync: 0,
    });
    expect(JSON.stringify(status)).not.toContain("secret-sheet-id");
  });
});

describe("TravelService custom base currency", () => {
  it("сохраняет общий курс и использует его для произвольной базовой валюты", async () => {
    const settings = new Map<string, string>([
      ["timezone", "Asia/Dubai"],
      ["base_currency", "RUB"],
      ["base_currency_rub_rate", "1"],
    ]);
    const updatedRates: Array<[string, number]> = [];
    const gateway = {
      getAccounts: async () => [],
      getTransactions: async () => [],
      getSettings: async () => settings,
      setSetting: async (_id: string, key: string, value: string) => { settings.set(key, value); },
      updateAccountRates: async (_id: string, currency: string, rate: number) => {
        updatedRates.push([currency, rate]);
      },
      refreshOverview: async () => undefined,
    };
    const stateStore = {
      getConnection: async () => ({
        spreadsheetId: "sheet",
        title: "ОАЭ",
        connectedAt: "2026-07-14T00:00:00.000Z",
      }),
    };
    const service = new TravelService(gateway as never, stateStore as never, config);

    await service.setCurrencyRubRate("42", "дирхам", 21.5);
    await service.setBaseCurrency("42", "AED");

    expect(await service.getBaseCurrency("42")).toBe("AED");
    expect(await service.getCurrencyRubRate("42", "AED")).toBe(21.5);
    expect(JSON.parse(settings.get("currency_rates_json")!)).toMatchObject({ RUB: 1, AED: 21.5 });
    expect(String(settings.get("base_currency_rub_rate"))).toBe("21.5");
    expect(updatedRates).toEqual([["AED", 21.5]]);
  });
});

describe("TravelService replacement recovery", () => {
  function originalIncome(): StoredTransaction {
    return {
      id: "tx_original",
      createdAt: "2026-07-15T08:00:00.000Z",
      date: "15.07.2026",
      type: "income",
      accountId: "rub",
      accountName: "Карта RUB",
      amount: 1000,
      currency: "RUB",
      purchaseAmount: 1000,
      purchaseCurrency: "RUB",
      amountRub: 1000,
      amountUsd: null,
      amountJpy: null,
      usdJpyRate: null,
      usdRubRate: null,
      jpyRubRate: null,
      category: "Пополнение",
      description: "Исходное пополнение",
      telegramUser: "@owner",
      chatId: "42",
      deletedAt: "",
      moneySyncStatus: "not_applicable",
      moneySyncError: "",
      moneySyncedAt: "",
      transferId: "",
      rowNumber: 5,
    };
  }

  function replacementService(
    markOriginal: (transaction: StoredTransaction, deletedAt: string) => void,
  ) {
    const transactions = [originalIncome()];
    const account: Account = {
      id: "rub",
      name: "Карта RUB",
      kind: "card",
      currency: "RUB",
      openingBalance: 0,
      rubRate: 1,
      active: true,
    };
    const gateway = {
      getAccounts: async () => [account],
      getSettings: async () => new Map([["timezone", "Europe/Moscow"]]),
      getTransactions: async () => transactions,
      appendTransaction: async (_spreadsheetId: string, value: TravelTransaction) => {
        const stored = { ...value, rowNumber: transactions.length + 5 };
        transactions.push(stored);
        return stored;
      },
      markTransactionDeleted: async (
        _spreadsheetId: string,
        value: StoredTransaction,
        deletedAt: string,
      ) => markOriginal(value, deletedAt),
    };
    const stateStore = {
      getConnection: async () => ({
        spreadsheetId: "sheet",
        title: "Поездка",
        connectedAt: "2026-07-15T00:00:00.000Z",
      }),
    };
    return {
      service: new TravelService(gateway as never, stateStore as never, config),
      transactions,
    };
  }

  it("при потерянном ответе после удаления признаёт замену успешной", async () => {
    let calls = 0;
    const { service, transactions } = replacementService((value, deletedAt) => {
      calls += 1;
      value.deletedAt = deletedAt;
      throw new Error("response lost after delete");
    });

    const replacement = await service.replaceTransaction(
      "42",
      "tx_original",
      { purchaseAmount: 1500, accountAmount: 1500 },
      "@owner",
    );

    expect(calls).toBe(1);
    expect(transactions.find((item) => item.id === "tx_original")?.deletedAt).not.toBe("");
    expect(transactions.find((item) => item.id === replacement.id)?.deletedAt).toBe("");
  });

  it("откатывает замену только когда исходная операция подтверждённо активна", async () => {
    const { service, transactions } = replacementService((value, deletedAt) => {
      if (value.id === "tx_original") throw new Error("delete rejected");
      value.deletedAt = deletedAt;
    });

    await expect(
      service.replaceTransaction(
        "42",
        "tx_original",
        { purchaseAmount: 1500, accountAmount: 1500 },
        "@owner",
      ),
    ).rejects.toThrow(/delete rejected/);

    expect(transactions.find((item) => item.id === "tx_original")?.deletedAt).toBe("");
    expect(transactions.at(-1)?.deletedAt).not.toBe("");
  });
});
