import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SheetConnection } from "../src/domain/types.js";
import { JsonStateStore, type FavoriteOperation } from "../src/state/jsonStore.js";

const japan: SheetConnection = {
  spreadsheetId: "sheet_japan_2026_abcdefghijkl",
  title: "Япония 2026",
  connectedAt: "2026-07-14T00:00:00.000Z",
};
const italy: SheetConnection = {
  spreadsheetId: "sheet_italy_2027_abcdefghijkl",
  title: "Италия 2027",
  connectedAt: "2026-07-15T00:00:00.000Z",
};

describe("JsonStateStore", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "travel-bot-state-"));
    filePath = path.join(directory, "state.json");
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("автоматически мигрирует старую связь с одной таблицей", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ connections: { "42": japan } }),
      "utf8",
    );

    const store = new JsonStateStore(filePath);
    expect(await store.getConnection("42")).toEqual(japan);
    expect(await store.getConnections("42")).toEqual([japan]);

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      version: number;
    };
    expect(persisted.version).toBe(2);
  });

  it("подключает несколько поездок и переключает активную", async () => {
    const store = new JsonStateStore(filePath);
    await store.setConnection("42", japan);
    await store.setConnection("42", italy);

    expect(await store.getConnection("42")).toEqual(italy);
    expect(await store.getConnections("42")).toEqual([italy, japan]);

    expect(await store.setActiveConnection("42", japan.spreadsheetId)).toEqual(japan);
    expect(await store.getConnection("42")).toEqual(japan);
  });

  it("возвращает уникальные поездки всех чатов для фоновой синхронизации", async () => {
    const store = new JsonStateStore(filePath);
    await store.setConnection("42", japan);
    await store.setConnection("43", japan);
    await store.setConnection("43", italy);

    expect(await store.getAllConnections()).toEqual([japan, italy]);
  });

  it("после отключения выбирает последнюю оставшуюся поездку", async () => {
    const store = new JsonStateStore(filePath);
    await store.setConnection("42", japan);
    await store.setConnection("42", italy);
    await store.setActiveConnection("42", japan.spreadsheetId);

    const firstResult = await store.removeConnection("42", japan.spreadsheetId);
    expect(firstResult).toEqual({ removed: japan, active: italy });

    const secondResult = await store.removeConnection("42", italy.spreadsheetId);
    expect(secondResult).toEqual({ removed: italy, active: null });
  });

  it("помнит сообщение панели между экземплярами хранилища", async () => {
    const store = new JsonStateStore(filePath);
    expect(await store.getScreenMessageId("42")).toBeNull();

    await store.setScreenMessageId("42", 1234);

    const reloadedStore = new JsonStateStore(filePath);
    expect(await reloadedStore.getScreenMessageId("42")).toBe(1234);
  });

  it("восстанавливает и очищает черновик после перезапуска", async () => {
    const store = new JsonStateStore(filePath);
    await store.setBotDraft("42", { kind: "transaction_purchase_amount", purchaseAmount: 1200 });

    const reloadedStore = new JsonStateStore(filePath);
    expect(await reloadedStore.getBotDraft("42")).toEqual({
      kind: "transaction_purchase_amount",
      purchaseAmount: 1200,
    });
    await reloadedStore.clearBotDraft("42");
    expect(await new JsonStateStore(filePath).getBotDraft("42")).toBeNull();
  });

  it("хранит избранное и отметку digest отдельно для активной поездки", async () => {
    const store = new JsonStateStore(filePath);
    await store.setConnection("42", japan);
    const favorite: FavoriteOperation = {
      id: "fav_1",
      name: "Рамен",
      type: "expense",
      accountId: "cash",
      accountAmount: 1200,
      purchaseAmount: 1200,
      purchaseCurrency: "JPY",
      category: "Питание",
      description: "Рамен",
      createdAt: "2026-07-14T10:00:00.000Z",
      useCount: 0,
    };
    await store.addFavorite("42", favorite);
    await store.incrementFavoriteUse("42", favorite.id);
    await store.setDigestLastSent("42", japan.spreadsheetId, "14.07.2026");

    expect((await store.getFavorites("42"))[0]?.useCount).toBe(1);
    expect(await store.getDigestLastSent("42", japan.spreadsheetId)).toBe("14.07.2026");
    expect(await store.getActiveChatConnections()).toEqual([{ chatId: "42", connection: japan }]);
  });
});
