import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SheetConnection } from "../src/domain/types.js";
import { JsonStateStore } from "../src/state/jsonStore.js";

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
});
