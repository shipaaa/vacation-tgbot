import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import {
  computeBalances,
  convertAmounts,
  summarizeExpenses,
} from "../domain/money.js";
import type {
  Account,
  AccountKind,
  ExchangeRates,
  SheetConnection,
  TransactionType,
  TravelTransaction,
} from "../domain/types.js";
import type { GoogleSheetsGateway } from "../google/sheetsGateway.js";
import type { JsonStateStore } from "../state/jsonStore.js";

export class UserFacingError extends Error {}

export interface NewTransactionInput {
  chatId: string;
  type: TransactionType;
  accountId: string;
  accountAmount: number;
  purchaseAmount: number;
  purchaseCurrency: string;
  category: string;
  description: string;
  telegramUser: string;
}

export class TravelService {
  constructor(
    private readonly gateway: GoogleSheetsGateway,
    private readonly stateStore: JsonStateStore,
    private readonly config: AppConfig,
    private readonly serviceAccountEmail?: string,
  ) {}

  async connect(chatId: string, spreadsheetInput: string): Promise<SheetConnection> {
    const spreadsheetId = extractSpreadsheetId(spreadsheetInput);
    if (!spreadsheetId) {
      throw new UserFacingError("Не вижу корректную ссылку или ID Google-таблицы.");
    }

    try {
      const title = await this.gateway.initializeSpreadsheet(
        spreadsheetId,
        this.config.defaultTimezone,
      );
      const connection = {
        spreadsheetId,
        title,
        connectedAt: new Date().toISOString(),
      };
      await this.stateStore.setConnection(chatId, connection);
      return connection;
    } catch (error) {
      const accessHint = this.serviceAccountEmail
        ? ` Дай доступ «Редактор» адресу ${this.serviceAccountEmail} и повтори /connect.`
        : " Проверь доступ service account к таблице.";
      throw new UserFacingError(`Не удалось открыть таблицу.${accessHint}`, { cause: error });
    }
  }

  getConnection(chatId: string): Promise<SheetConnection | null> {
    return this.stateStore.getConnection(chatId);
  }

  getConnections(chatId: string): Promise<SheetConnection[]> {
    return this.stateStore.getConnections(chatId);
  }

  async selectConnection(
    chatId: string,
    spreadsheetId: string,
  ): Promise<SheetConnection> {
    const connection = await this.stateStore.setActiveConnection(chatId, spreadsheetId);
    if (!connection) {
      throw new UserFacingError("Эта поездка больше не подключена к чату.");
    }
    return connection;
  }

  async disconnectCurrent(chatId: string) {
    const connection = await this.requireConnection(chatId);
    return this.stateStore.removeConnection(chatId, connection.spreadsheetId);
  }

  async getAccounts(chatId: string): Promise<Account[]> {
    const connection = await this.requireConnection(chatId);
    return this.gateway.getAccounts(connection.spreadsheetId);
  }

  async addAccount(
    chatId: string,
    kind: AccountKind,
    name: string,
    currency: string,
    openingBalance: number,
    rubRate: number,
  ): Promise<Account> {
    const connection = await this.requireConnection(chatId);
    const account: Account = {
      id: `acc_${randomUUID().slice(0, 8)}`,
      name,
      kind,
      currency: currency.toUpperCase(),
      openingBalance,
      rubRate: currency.toUpperCase() === "RUB" ? 1 : rubRate,
      active: true,
    };
    await this.gateway.addAccount(connection.spreadsheetId, account);
    if (account.currency === "USD" || account.currency === "JPY") {
      await Promise.all([
        this.gateway.setSetting(
          connection.spreadsheetId,
          account.currency === "USD" ? "usd_rub_rate" : "jpy_rub_rate",
          String(account.rubRate),
        ),
        this.gateway.updateAccountRates(
          connection.spreadsheetId,
          account.currency,
          account.rubRate,
        ),
      ]);
    }
    return account;
  }

  async getRates(chatId: string): Promise<ExchangeRates> {
    const connection = await this.requireConnection(chatId);
    const settings = await this.gateway.getSettings(connection.spreadsheetId);
    return ratesFromSettings(settings);
  }

  async getBaseCurrency(chatId: string): Promise<string> {
    const connection = await this.requireConnection(chatId);
    const settings = await this.gateway.getSettings(connection.spreadsheetId);
    return (settings.get("base_currency") || "RUB").toUpperCase();
  }

  async getHomeTimezone(chatId: string): Promise<string> {
    const connection = await this.requireConnection(chatId);
    const settings = await this.gateway.getSettings(connection.spreadsheetId);
    return settings.get("home_timezone") || "Europe/Moscow";
  }

  async setHomeTimezone(chatId: string, timezone: string): Promise<string> {
    const normalized = timezone.trim();
    try {
      new Intl.DateTimeFormat("ru-RU", { timeZone: normalized }).format(new Date());
    } catch {
      throw new UserFacingError("Не узнаю этот часовой пояс. Пример: Europe/Moscow.");
    }
    const connection = await this.requireConnection(chatId);
    await this.gateway.setSetting(connection.spreadsheetId, "home_timezone", normalized);
    return normalized;
  }

  async setBaseCurrency(chatId: string, currency: string): Promise<string> {
    const normalized = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) {
      throw new UserFacingError("Нужен трёхбуквенный код валюты, например JPY.");
    }
    const connection = await this.requireConnection(chatId);
    await this.gateway.setSetting(connection.spreadsheetId, "base_currency", normalized);
    await this.gateway.refreshOverview(connection.spreadsheetId);
    return normalized;
  }

  async setRate(
    chatId: string,
    currency: "USD" | "JPY",
    rubRate: number,
  ): Promise<void> {
    const connection = await this.requireConnection(chatId);
    await Promise.all([
      this.gateway.setSetting(
        connection.spreadsheetId,
        currency === "USD" ? "usd_rub_rate" : "jpy_rub_rate",
        String(rubRate),
      ),
      this.gateway.updateAccountRates(connection.spreadsheetId, currency, rubRate),
    ]);
  }

  async estimateAccountAmount(
    chatId: string,
    accountId: string,
    purchaseAmount: number,
    purchaseCurrency: string,
  ): Promise<number> {
    const connection = await this.requireConnection(chatId);
    const [accounts, settings] = await Promise.all([
      this.gateway.getAccounts(connection.spreadsheetId),
      this.gateway.getSettings(connection.spreadsheetId),
    ]);
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new UserFacingError("Счёт больше не найден.");
    const rates = ratesFromSettings(settings);
    const purchaseRate = rubRateForCurrency(purchaseCurrency, rates);
    const accountRate = rubRateForCurrency(account.currency, rates, account.rubRate);
    if (!purchaseRate || !accountRate) {
      throw new UserFacingError("Не хватает курса. Укажи его через /rates.");
    }
    return (purchaseAmount * purchaseRate) / accountRate;
  }

  async getCategories(chatId: string): Promise<string[]> {
    const connection = await this.requireConnection(chatId);
    return this.gateway.getCategories(connection.spreadsheetId);
  }

  async recordTransaction(input: NewTransactionInput): Promise<TravelTransaction> {
    const connection = await this.requireConnection(input.chatId);
    const accounts = await this.gateway.getAccounts(connection.spreadsheetId);
    const account = accounts.find((candidate) => candidate.id === input.accountId);
    if (!account) throw new UserFacingError("Счёт больше не найден. Начни ввод заново.");
    const settings = await this.gateway.getSettings(connection.spreadsheetId);
    const timezone = settings.get("timezone") || this.config.defaultTimezone;
    const rates = ratesFromSettings(settings);
    const converted = convertAmounts({
      purchaseAmount: input.purchaseAmount,
      purchaseCurrency: input.purchaseCurrency,
      accountAmount: input.accountAmount,
      accountCurrency: account.currency,
      accountRubRate: rubRateForCurrency(account.currency, rates, account.rubRate) ?? account.rubRate,
      rates,
    });
    if (converted.amountRub === null) {
      throw new UserFacingError(
        `Для счёта «${account.name}» не задан курс ${account.currency}/RUB. Используй /rates или пересоздай счёт.`,
      );
    }
    const transaction: TravelTransaction = {
      id: `tx_${randomUUID().slice(0, 12)}`,
      createdAt: new Date().toISOString(),
      date: dateInTimezone(new Date(), timezone),
      type: input.type,
      accountId: account.id,
      accountName: account.name,
      amount: input.accountAmount,
      currency: account.currency,
      purchaseAmount: input.purchaseAmount,
      purchaseCurrency: input.purchaseCurrency.toUpperCase(),
      ...converted,
      category: input.type === "income" ? "Пополнение" : input.category,
      description: input.description,
      telegramUser: input.telegramUser,
      chatId: input.chatId,
      deletedAt: "",
    };
    await this.gateway.appendTransaction(connection.spreadsheetId, transaction);
    return transaction;
  }

  async getBalances(chatId: string) {
    const connection = await this.requireConnection(chatId);
    const [accounts, transactions] = await Promise.all([
      this.gateway.getAccounts(connection.spreadsheetId),
      this.gateway.getTransactions(connection.spreadsheetId),
    ]);
    return computeBalances(accounts, transactions);
  }

  async getSummary(chatId: string, todayOnly: boolean) {
    const connection = await this.requireConnection(chatId);
    const [transactions, settings] = await Promise.all([
      this.gateway.getTransactions(connection.spreadsheetId),
      this.gateway.getSettings(connection.spreadsheetId),
    ]);
    const timezone = settings.get("timezone") || this.config.defaultTimezone;
    const baseCurrency = (settings.get("base_currency") || "RUB").toUpperCase();
    const date = todayOnly ? dateInTimezone(new Date(), timezone) : undefined;
    return { date, baseCurrency, lines: summarizeExpenses(transactions, baseCurrency, date) };
  }

  async undoLast(chatId: string): Promise<TravelTransaction | null> {
    const connection = await this.requireConnection(chatId);
    const transactions = await this.gateway.getTransactions(connection.spreadsheetId);
    const latest = [...transactions]
      .reverse()
      .find((transaction) => transaction.chatId === chatId && !transaction.deletedAt);
    if (!latest) return null;
    await this.gateway.markTransactionDeleted(
      connection.spreadsheetId,
      latest,
      new Date().toISOString(),
    );
    return latest;
  }

  private async requireConnection(chatId: string): Promise<SheetConnection> {
    const connection = await this.stateStore.getConnection(chatId);
    if (!connection) {
      throw new UserFacingError(
        "Сначала подключи таблицу командой /connect и вставь ссылку на Google Sheets.",
      );
    }
    return connection;
  }
}

function ratesFromSettings(settings: Map<string, string>): ExchangeRates {
  return {
    usdRub: positiveSetting(settings.get("usd_rub_rate")),
    jpyRub: positiveSetting(settings.get("jpy_rub_rate")),
  };
}

function positiveSetting(value: string | undefined): number | null {
  if (!value) return null;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function rubRateForCurrency(
  currency: string,
  rates: ExchangeRates,
  accountRate?: number,
): number | null {
  if (currency.toUpperCase() === "RUB") return 1;
  if (currency.toUpperCase() === "USD") return rates.usdRub ?? accountRate ?? null;
  if (currency.toUpperCase() === "JPY") return rates.jpyRub ?? accountRate ?? null;
  return accountRate && accountRate > 0 ? accountRate : null;
}

export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch?.[1]) return urlMatch[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}

function dateInTimezone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
