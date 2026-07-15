import { describe, expect, it } from "vitest";
import type { TravelTransaction } from "../src/domain/types.js";
import { GoogleSheetsGateway } from "../src/google/sheetsGateway.js";

function transaction(
  overrides: Partial<TravelTransaction> = {},
): TravelTransaction {
  return {
    id: "tx_retry_safe",
    createdAt: "2026-07-15T09:00:00.000Z",
    date: "15.07.2026",
    type: "income",
    accountId: "acc_rub",
    accountName: "Карта RUB",
    amount: 1000,
    currency: "RUB",
    purchaseAmount: 1000,
    purchaseCurrency: "RUB",
    amountRub: 1000,
    amountUsd: 12.5,
    amountJpy: 2000,
    usdJpyRate: 160,
    usdRubRate: 80,
    jpyRubRate: 0.5,
    category: "Пополнение",
    description: "Пополнение карты",
    telegramUser: "@owner",
    chatId: "42",
    deletedAt: "",
    moneySyncStatus: "not_applicable",
    moneySyncError: "",
    moneySyncedAt: "",
    transferId: "",
    ...overrides,
  };
}

function createGatewayHarness(options: { failAfterFirstAppend?: boolean } = {}) {
  const rows: unknown[][] = [];
  let appendCalls = 0;
  let failAfterFirstAppend = options.failAfterFirstAppend ?? false;
  const client = {
    spreadsheets: {
      values: {
        get: async () => ({ data: { values: rows } }),
        append: async (request: { requestBody?: { values?: unknown[][] } }) => {
          appendCalls += 1;
          rows.push(...(request.requestBody?.values ?? []).map((row) => [...row]));
          if (failAfterFirstAppend) {
            failAfterFirstAppend = false;
            throw new Error("response lost after append");
          }
          return {
            data: {
              updates: {
                updatedRange: `'Траты'!A${rows.length + 4}:Y${rows.length + 4}`,
              },
            },
          };
        },
      },
    },
  };
  const gateway = new GoogleSheetsGateway({} as never);
  Object.assign(gateway as unknown as Record<string, unknown>, { client });
  return {
    gateway,
    rows,
    appendCalls: () => appendCalls,
  };
}

describe("GoogleSheetsGateway idempotent ledger append", () => {
  it("не создаёт дубль, если ответ Google потерян после фактической записи", async () => {
    const harness = createGatewayHarness({ failAfterFirstAppend: true });
    const input = transaction();

    const stored = await harness.gateway.appendTransaction("sheet", input);

    expect(stored.id).toBe(input.id);
    expect(harness.rows).toHaveLength(1);
    expect(harness.appendCalls()).toBe(1);
  });

  it("сериализует конкурентные повторы одного transaction ID", async () => {
    const harness = createGatewayHarness();
    const input = transaction();

    const [first, second] = await Promise.all([
      harness.gateway.appendTransaction("sheet", input),
      harness.gateway.appendTransaction("sheet", { ...input }),
    ]);

    expect(first.id).toBe(second.id);
    expect(harness.rows).toHaveLength(1);
    expect(harness.appendCalls()).toBe(1);
  });

  it("не принимает другой финансовый смысл под существующим ID", async () => {
    const harness = createGatewayHarness();
    const input = transaction();
    await harness.gateway.appendTransaction("sheet", input);

    await expect(
      harness.gateway.appendTransaction("sheet", { ...input, amount: 2000 }),
    ).rejects.toThrow(/Конфликт повторной операции/);
    expect(harness.rows).toHaveLength(1);
  });

  it("повторяет пару перевода без появления третьей строки", async () => {
    const harness = createGatewayHarness({ failAfterFirstAppend: true });
    const source = transaction({
      id: "tx_transfer_out",
      type: "transfer_out",
      amount: 100,
      purchaseAmount: 100,
      category: "Перевод",
      description: "Карта → наличные",
      transferId: "tr_retry_safe",
    });
    const destination = transaction({
      id: "tx_transfer_in",
      type: "transfer_in",
      accountId: "acc_cash",
      accountName: "Наличные RUB",
      amount: 100,
      purchaseAmount: 100,
      category: "Перевод",
      description: "Карта → наличные",
      transferId: "tr_retry_safe",
    });

    const stored = await harness.gateway.appendTransferTransactions(
      "sheet",
      [source, destination],
    );

    expect(stored.map((item) => item.id)).toEqual([source.id, destination.id]);
    expect(harness.rows).toHaveLength(2);
    expect(harness.appendCalls()).toBe(1);
  });
});
