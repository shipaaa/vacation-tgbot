import fs from "node:fs/promises";
import path from "node:path";
import type { SheetConnection } from "../domain/types.js";

interface ChatState {
  connections: Record<string, SheetConnection>;
  activeSpreadsheetId: string | null;
  screenMessageId?: number;
  botDraft?: unknown;
  favorites?: Record<string, FavoriteOperation[]>;
  digestLastSent?: Record<string, string>;
}

export interface FavoriteOperation {
  id: string;
  name: string;
  type: "expense" | "income";
  accountId: string;
  accountAmount: number;
  purchaseAmount: number;
  purchaseCurrency: string;
  category: string;
  description: string;
  createdAt: string;
  useCount: number;
}

export interface ActiveChatConnection {
  chatId: string;
  connection: SheetConnection;
}

interface StoredState {
  version: 2;
  chats: Record<string, ChatState>;
}

interface LegacyState {
  connections?: Record<string, SheetConnection>;
}

const EMPTY_STATE: StoredState = { version: 2, chats: {} };

export interface RemoveConnectionResult {
  removed: SheetConnection | null;
  active: SheetConnection | null;
}

export class JsonStateStore {
  private state: StoredState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getConnection(chatId: string): Promise<SheetConnection | null> {
    const chat = (await this.load()).chats[chatId];
    if (!chat?.activeSpreadsheetId) return null;
    return chat.connections[chat.activeSpreadsheetId] ?? null;
  }

  async getConnections(chatId: string): Promise<SheetConnection[]> {
    const chat = (await this.load()).chats[chatId];
    if (!chat) return [];
    return Object.values(chat.connections).sort(
      (left, right) => right.connectedAt.localeCompare(left.connectedAt),
    );
  }

  async getAllConnections(): Promise<SheetConnection[]> {
    const unique = new Map<string, SheetConnection>();
    for (const chat of Object.values((await this.load()).chats)) {
      for (const connection of Object.values(chat.connections)) {
        const current = unique.get(connection.spreadsheetId);
        if (!current || connection.connectedAt > current.connectedAt) {
          unique.set(connection.spreadsheetId, connection);
        }
      }
    }
    return [...unique.values()];
  }

  async getActiveChatConnections(): Promise<ActiveChatConnection[]> {
    const result: ActiveChatConnection[] = [];
    for (const [chatId, chat] of Object.entries((await this.load()).chats)) {
      if (!chat.activeSpreadsheetId) continue;
      const connection = chat.connections[chat.activeSpreadsheetId];
      if (connection) result.push({ chatId, connection });
    }
    return result;
  }

  async getDigestLastSent(chatId: string, spreadsheetId: string): Promise<string | null> {
    return (await this.load()).chats[chatId]?.digestLastSent?.[spreadsheetId] ?? null;
  }

  async setDigestLastSent(
    chatId: string,
    spreadsheetId: string,
    localDate: string,
  ): Promise<void> {
    const state = await this.load();
    const chat = state.chats[chatId];
    if (!chat) return;
    chat.digestLastSent ??= {};
    chat.digestLastSent[spreadsheetId] = localDate;
    await this.queuePersist(state);
  }

  async getScreenMessageId(chatId: string): Promise<number | null> {
    const messageId = (await this.load()).chats[chatId]?.screenMessageId;
    return Number.isInteger(messageId) && (messageId ?? 0) > 0 ? messageId ?? null : null;
  }

  async setScreenMessageId(chatId: string, messageId: number): Promise<void> {
    if (!Number.isInteger(messageId) || messageId <= 0) return;
    const state = await this.load();
    const chat = state.chats[chatId] ?? {
      connections: {},
      activeSpreadsheetId: null,
    };
    chat.screenMessageId = messageId;
    state.chats[chatId] = chat;
    await this.queuePersist(state);
  }

  async getBotDraft(chatId: string): Promise<unknown | null> {
    return (await this.load()).chats[chatId]?.botDraft ?? null;
  }

  async setBotDraft(chatId: string, draft: unknown): Promise<void> {
    const state = await this.load();
    const chat = state.chats[chatId] ?? {
      connections: {},
      activeSpreadsheetId: null,
    };
    chat.botDraft = structuredClone(draft);
    state.chats[chatId] = chat;
    await this.queuePersist(state);
  }

  async clearBotDraft(chatId: string): Promise<void> {
    const state = await this.load();
    const chat = state.chats[chatId];
    if (!chat || chat.botDraft === undefined) return;
    delete chat.botDraft;
    await this.queuePersist(state);
  }

  async getFavorites(chatId: string): Promise<FavoriteOperation[]> {
    const chat = (await this.load()).chats[chatId];
    if (!chat?.activeSpreadsheetId) return [];
    return [...(chat.favorites?.[chat.activeSpreadsheetId] ?? [])].sort(
      (left, right) => right.useCount - left.useCount || right.createdAt.localeCompare(left.createdAt),
    );
  }

  async addFavorite(chatId: string, favorite: FavoriteOperation): Promise<void> {
    const state = await this.load();
    const chat = state.chats[chatId];
    if (!chat?.activeSpreadsheetId) return;
    chat.favorites ??= {};
    const current = chat.favorites[chat.activeSpreadsheetId] ?? [];
    const duplicate = current.find(
      (item) => item.type === favorite.type && item.accountId === favorite.accountId &&
        item.purchaseAmount === favorite.purchaseAmount &&
        item.purchaseCurrency === favorite.purchaseCurrency &&
        item.category === favorite.category && item.description === favorite.description,
    );
    chat.favorites[chat.activeSpreadsheetId] = duplicate
      ? current.map((item) => item.id === duplicate.id ? { ...item, name: favorite.name } : item)
      : [favorite, ...current].slice(0, 20);
    await this.queuePersist(state);
  }

  async removeFavorite(chatId: string, favoriteId: string): Promise<boolean> {
    const state = await this.load();
    const chat = state.chats[chatId];
    const spreadsheetId = chat?.activeSpreadsheetId;
    if (!chat || !spreadsheetId) return false;
    const current = chat.favorites?.[spreadsheetId] ?? [];
    const next = current.filter((item) => item.id !== favoriteId);
    if (next.length === current.length) return false;
    chat.favorites ??= {};
    chat.favorites[spreadsheetId] = next;
    await this.queuePersist(state);
    return true;
  }

  async incrementFavoriteUse(chatId: string, favoriteId: string): Promise<void> {
    const state = await this.load();
    const chat = state.chats[chatId];
    const spreadsheetId = chat?.activeSpreadsheetId;
    if (!chat || !spreadsheetId) return;
    const favorite = chat.favorites?.[spreadsheetId]?.find((item) => item.id === favoriteId);
    if (!favorite) return;
    favorite.useCount += 1;
    await this.queuePersist(state);
  }

  async setConnection(chatId: string, connection: SheetConnection): Promise<void> {
    const state = await this.load();
    const chat = state.chats[chatId] ?? {
      connections: {},
      activeSpreadsheetId: null,
    };
    chat.connections[connection.spreadsheetId] = connection;
    chat.activeSpreadsheetId = connection.spreadsheetId;
    state.chats[chatId] = chat;
    await this.queuePersist(state);
  }

  async setActiveConnection(
    chatId: string,
    spreadsheetId: string,
  ): Promise<SheetConnection | null> {
    const state = await this.load();
    const chat = state.chats[chatId];
    const connection = chat?.connections[spreadsheetId];
    if (!chat || !connection) return null;
    chat.activeSpreadsheetId = spreadsheetId;
    await this.queuePersist(state);
    return connection;
  }

  async removeConnection(
    chatId: string,
    spreadsheetId: string,
  ): Promise<RemoveConnectionResult> {
    const state = await this.load();
    const chat = state.chats[chatId];
    const removed = chat?.connections[spreadsheetId] ?? null;
    if (!chat || !removed) return { removed: null, active: await this.getConnection(chatId) };

    delete chat.connections[spreadsheetId];
    if (chat.activeSpreadsheetId === spreadsheetId) {
      const next = Object.values(chat.connections).sort(
        (left, right) => right.connectedAt.localeCompare(left.connectedAt),
      )[0];
      chat.activeSpreadsheetId = next?.spreadsheetId ?? null;
    }
    await this.queuePersist(state);
    const active = chat.activeSpreadsheetId
      ? chat.connections[chat.activeSpreadsheetId] ?? null
      : null;
    return { removed, active };
  }

  private async load(): Promise<StoredState> {
    if (this.state) return this.state;
    try {
      const parsed = parseState(await fs.readFile(this.filePath, "utf8"));
      this.state = isCurrentState(parsed) ? parsed : migrateLegacyState(parsed);
      if (!isCurrentState(parsed)) await this.queuePersist(this.state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = await this.restoreMissingPrimaryOrCreateEmpty();
      } else {
        this.state = await this.restoreBackup(error);
      }
    }
    return this.state;
  }

  private async restoreMissingPrimaryOrCreateEmpty(): Promise<StoredState> {
    try {
      const parsed = parseState(await fs.readFile(`${this.filePath}.bak`, "utf8"));
      const recovered = isCurrentState(parsed) ? parsed : migrateLegacyState(parsed);
      await this.queuePersist(recovered);
      return recovered;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw new Error(`Не удалось восстановить ${this.filePath} из резервной копии.`, {
        cause: error,
      });
    }
  }

  private async restoreBackup(primaryError: unknown): Promise<StoredState> {
    try {
      const parsed = parseState(await fs.readFile(`${this.filePath}.bak`, "utf8"));
      const recovered = isCurrentState(parsed) ? parsed : migrateLegacyState(parsed);
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await fs.rename(this.filePath, corruptPath);
        await this.queuePersist(recovered);
      } catch {
        // Keep using the valid backup in memory if the damaged file cannot be quarantined.
      }
      return recovered;
    } catch (backupError) {
      throw new Error(
        `Не удалось прочитать ${this.filePath}; валидная резервная копия также недоступна.`,
        { cause: { primaryError, backupError } },
      );
    }
  }

  private async queuePersist(state: StoredState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    const current = this.writeQueue
      .catch(() => undefined)
      .then(() => this.persist(snapshot));
    this.writeQueue = current;
    await current;
  }

  private async persist(content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    const backupPath = `${this.filePath}.bak`;
    const backupTempPath = `${backupPath}.tmp`;
    try {
      await fs.copyFile(this.filePath, backupTempPath);
      await fs.chmod(backupTempPath, 0o600);
      await fs.rename(backupTempPath, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(tempPath, this.filePath);
  }
}

function parseState(content: string): StoredState | LegacyState {
  const parsed: unknown = JSON.parse(content);
  if (isCurrentState(parsed) || isLegacyState(parsed)) return parsed;
  throw new Error("Файл состояния имеет неподдерживаемую структуру.");
}

function isCurrentState(state: unknown): state is StoredState {
  if (!isRecord(state) || state.version !== 2 || !isRecord(state.chats)) return false;
  return Object.values(state.chats).every((chat) => {
    if (
      !isRecord(chat) || !isRecord(chat.connections) ||
      !(chat.activeSpreadsheetId === null || typeof chat.activeSpreadsheetId === "string")
    ) {
      return false;
    }
    if (!Object.values(chat.connections).every(isSheetConnection)) return false;
    if (chat.screenMessageId !== undefined && !Number.isInteger(chat.screenMessageId)) return false;
    if (
      chat.favorites !== undefined &&
      (!isRecord(chat.favorites) || !Object.values(chat.favorites).every(Array.isArray))
    ) {
      return false;
    }
    if (
      chat.digestLastSent !== undefined &&
      (!isRecord(chat.digestLastSent) ||
        !Object.values(chat.digestLastSent).every((value) => typeof value === "string"))
    ) {
      return false;
    }
    return true;
  });
}

function isLegacyState(state: unknown): state is LegacyState {
  return isRecord(state) && !("version" in state) &&
    Object.keys(state).every((key) => key === "connections") &&
    (state.connections === undefined ||
      (isRecord(state.connections) && Object.values(state.connections).every(isSheetConnection)));
}

function isSheetConnection(value: unknown): value is SheetConnection {
  return isRecord(value) &&
    typeof value.spreadsheetId === "string" &&
    typeof value.title === "string" &&
    typeof value.connectedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function migrateLegacyState(legacy: LegacyState): StoredState {
  const state = structuredClone(EMPTY_STATE);
  for (const [chatId, connection] of Object.entries(legacy.connections ?? {})) {
    state.chats[chatId] = {
      connections: { [connection.spreadsheetId]: connection },
      activeSpreadsheetId: connection.spreadsheetId,
    };
  }
  return state;
}
