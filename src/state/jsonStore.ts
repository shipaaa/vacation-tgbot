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
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as
        | StoredState
        | LegacyState;
      this.state = isCurrentState(parsed) ? parsed : migrateLegacyState(parsed);
      if (!isCurrentState(parsed)) await this.queuePersist(this.state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = structuredClone(EMPTY_STATE);
    }
    return this.state;
  }

  private async queuePersist(state: StoredState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    this.writeQueue = this.writeQueue.then(() => this.persist(snapshot));
    await this.writeQueue;
  }

  private async persist(content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

function isCurrentState(state: StoredState | LegacyState): state is StoredState {
  return "version" in state && state.version === 2 && "chats" in state;
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
