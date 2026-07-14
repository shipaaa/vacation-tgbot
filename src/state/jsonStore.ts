import fs from "node:fs/promises";
import path from "node:path";
import type { SheetConnection } from "../domain/types.js";

interface ChatState {
  connections: Record<string, SheetConnection>;
  activeSpreadsheetId: string | null;
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
