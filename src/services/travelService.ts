import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { normalizeCurrencyCode } from "../domain/currency.js";
import { dateInTimezone, formatDate } from "../domain/date.js";
import {
  computeBalances,
  convertAmounts,
  summarizeExpenses,
  summarizeExpensesByParticipant,
} from "../domain/money.js";
import type { ManualMoneySyncResult } from "../domain/moneyImport.js";
import type {
  Account,
  AccountBalance,
  AccountKind,
  DirectTransactionType,
  ExchangeRates,
  SheetConnection,
  StoredTransaction,
  SummaryLine,
  TransactionType,
  TravelTransaction,
} from "../domain/types.js";
import type { GoogleSheetsGateway } from "../google/sheetsGateway.js";
import type { FavoriteOperation, JsonStateStore } from "../state/jsonStore.js";

export class UserFacingError extends Error {}

const HOME_TIMEZONES = new Set(["Europe/Moscow", "Asia/Dubai", "Asia/Tokyo"]);

export interface NewTransactionInput {
  chatId: string;
  type: DirectTransactionType;
  accountId: string;
  accountAmount: number;
  purchaseAmount: number;
  purchaseCurrency: string;
  category: string;
  description: string;
  telegramUser: string;
  date?: string;
  rates?: ExchangeRates;
  accountRubRate?: number;
}

export interface TransactionChanges {
  accountId?: string;
  accountAmount?: number;
  purchaseAmount?: number;
  purchaseCurrency?: string;
  category?: string;
  description?: string;
}

export interface NewTransferInput {
  chatId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  sourceAmount: number;
  destinationAmount: number;
  description: string;
  telegramUser: string;
  date?: string;
  rates?: ExchangeRates;
}

export interface RecordedTransfer {
  source: TravelTransaction;
  destination: TravelTransaction;
}

export interface BudgetProgress {
  limit: number;
  spent: number;
  remaining: number;
  percent: number;
}

export interface BudgetStatus {
  baseCurrency: string;
  daily: BudgetProgress | null;
  categories: Array<{ category: string } & BudgetProgress>;
}

export interface DashboardSnapshot {
  connection: SheetConnection;
  baseCurrency: string;
  balances: AccountBalance[];
  today: { date: string; baseCurrency: string; lines: SummaryLine[] };
  homeTimezone: string;
  localTimezone: string;
  budgets: BudgetStatus;
  digest: { enabled: boolean; time: string };
}

export interface DigestDelivery {
  chatId: string;
  spreadsheetId: string;
  localDate: string;
  title: string;
  baseCurrency: string;
  todaySpent: number;
  balances: AccountBalance[];
  budgets: BudgetStatus;
}

export class TravelService {
  private readonly dashboardCache = new Map<
    string,
    { expiresAt: number; value: DashboardSnapshot }
  >();

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
      this.invalidateDashboard(spreadsheetId);
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

  async syncAllPendingMoney(): Promise<{ synced: number; failed: number }> {
    const connections = await this.stateStore.getAllConnections();
    const results = await Promise.allSettled(
      connections.map((connection) =>
        this.gateway.syncPendingMoneyTransactions(connection.spreadsheetId)
      ),
    );
    return results.reduce(
      (total, result) => {
        if (result.status === "fulfilled") {
          total.synced += result.value.synced;
          total.failed += result.value.failed;
        } else {
          total.failed += 1;
          console.error("Ошибка фоновой синхронизации Money:", result.reason);
        }
        return total;
      },
      { synced: 0, failed: 0 },
    );
  }

  async syncManualMoney(chatId: string): Promise<ManualMoneySyncResult> {
    const connection = await this.requireConnection(chatId);
    const result = await this.gateway.syncManualMoneyTransactions(
      connection.spreadsheetId,
      chatId,
    );
    if (result.imported || result.updated || result.deleted) {
      this.invalidateDashboard(connection.spreadsheetId);
    }
    return result;
  }

  async initializeAllConnections(): Promise<{ prepared: number; failed: number }> {
    const connections = await this.stateStore.getAllConnections();
    const results = await Promise.allSettled(
      connections.map((connection) =>
        this.gateway.initializeSpreadsheet(
          connection.spreadsheetId,
          this.config.defaultTimezone,
        )
      ),
    );
    return results.reduce(
      (total, result) => {
        if (result.status === "fulfilled") total.prepared += 1;
        else {
          total.failed += 1;
          console.error("Ошибка подготовки подключённой таблицы:", result.reason);
        }
        return total;
      },
      { prepared: 0, failed: 0 },
    );
  }

  getScreenMessageId(chatId: string): Promise<number | null> {
    return this.stateStore.getScreenMessageId(chatId);
  }

  setScreenMessageId(chatId: string, messageId: number): Promise<void> {
    return this.stateStore.setScreenMessageId(chatId, messageId);
  }

  getBotDraft(chatId: string): Promise<unknown | null> {
    return this.stateStore.getBotDraft(chatId);
  }

  setBotDraft(chatId: string, draft: unknown): Promise<void> {
    return this.stateStore.setBotDraft(chatId, draft);
  }

  clearBotDraft(chatId: string): Promise<void> {
    return this.stateStore.clearBotDraft(chatId);
  }

  getFavorites(chatId: string): Promise<FavoriteOperation[]> {
    return this.stateStore.getFavorites(chatId);
  }

  async saveFavorite(chatId: string, transactionId: string): Promise<FavoriteOperation> {
    const transaction = await this.getTransaction(chatId, transactionId);
    if (transaction.type !== "expense" && transaction.type !== "income") {
      throw new UserFacingError("Переводы пока нельзя сохранить как быстрый шаблон.");
    }
    const favorite: FavoriteOperation = {
      id: `fav_${randomUUID().slice(0, 10)}`,
      name: transaction.description || transaction.category,
      type: transaction.type,
      accountId: transaction.accountId,
      accountAmount: transaction.amount,
      purchaseAmount: transaction.purchaseAmount,
      purchaseCurrency: transaction.purchaseCurrency,
      category: transaction.category,
      description: transaction.description,
      createdAt: new Date().toISOString(),
      useCount: 0,
    };
    await this.stateStore.addFavorite(chatId, favorite);
    return favorite;
  }

  async useFavorite(
    chatId: string,
    favoriteId: string,
    telegramUser: string,
  ): Promise<TravelTransaction> {
    const favorite = (await this.stateStore.getFavorites(chatId))
      .find((item) => item.id === favoriteId);
    if (!favorite) throw new UserFacingError("Быстрый шаблон не найден.");
    const transaction = await this.recordTransaction({
      chatId,
      type: favorite.type,
      accountId: favorite.accountId,
      accountAmount: favorite.accountAmount,
      purchaseAmount: favorite.purchaseAmount,
      purchaseCurrency: favorite.purchaseCurrency,
      category: favorite.category,
      description: favorite.description,
      telegramUser,
    });
    await this.stateStore.incrementFavoriteUse(chatId, favoriteId);
    return transaction;
  }

  async removeFavorite(chatId: string, favoriteId: string): Promise<void> {
    if (!(await this.stateStore.removeFavorite(chatId, favoriteId))) {
      throw new UserFacingError("Быстрый шаблон уже удалён.");
    }
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
    await this.storeCurrencyRubRate(
      connection.spreadsheetId,
      account.currency,
      account.rubRate,
    );
    this.invalidateDashboard(connection.spreadsheetId);
    return account;
  }

  async getDashboard(chatId: string): Promise<DashboardSnapshot> {
    const connection = await this.requireConnection(chatId);
    const cached = this.dashboardCache.get(connection.spreadsheetId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const [accounts, transactions, settings] = await Promise.all([
      this.gateway.getAccounts(connection.spreadsheetId),
      this.gateway.getTransactions(connection.spreadsheetId),
      this.gateway.getSettings(connection.spreadsheetId),
    ]);
    const baseCurrency = (settings.get("base_currency") || "RUB").toUpperCase();
    const baseRubRate = currencyRubRateFromSettings(settings, baseCurrency);
    const localTimezone = settings.get("timezone") || this.config.defaultTimezone;
    const configuredHome = settings.get("home_timezone") || "Europe/Moscow";
    const homeTimezone = HOME_TIMEZONES.has(configuredHome) ? configuredHome : "Europe/Moscow";
    const date = dateInTimezone(new Date(), localTimezone);
    const value: DashboardSnapshot = {
      connection,
      baseCurrency,
      balances: computeBalances(accounts, transactions),
      today: {
        date,
        baseCurrency,
        lines: summarizeExpenses(transactions, baseCurrency, date, baseRubRate),
      },
      homeTimezone,
      localTimezone,
      budgets: buildBudgetStatus(transactions, settings, baseCurrency, date, baseRubRate),
      digest: {
        enabled: settings.get("daily_digest_enabled") === "true",
        time: validDigestTime(settings.get("daily_digest_time")) ?? "21:00",
      },
    };
    this.dashboardCache.set(connection.spreadsheetId, {
      expiresAt: Date.now() + 15_000,
      value,
    });
    return value;
  }

  async getBudgetStatus(chatId: string): Promise<BudgetStatus> {
    return (await this.getDashboard(chatId)).budgets;
  }

  async setDailyBudget(chatId: string, limit: number): Promise<void> {
    if (!Number.isFinite(limit) || limit < 0) {
      throw new UserFacingError("Лимит должен быть положительным числом или 0 для отключения.");
    }
    const connection = await this.requireConnection(chatId);
    await this.gateway.setSetting(
      connection.spreadsheetId,
      "daily_budget",
      limit > 0 ? String(limit) : "",
    );
    this.invalidateDashboard(connection.spreadsheetId);
  }

  async setCategoryBudget(chatId: string, category: string, limit: number): Promise<void> {
    if (!Number.isFinite(limit) || limit < 0) {
      throw new UserFacingError("Лимит должен быть положительным числом или 0 для отключения.");
    }
    const connection = await this.requireConnection(chatId);
    const settings = await this.gateway.getSettings(connection.spreadsheetId);
    const budgets = parseCategoryBudgets(settings.get("category_budgets_json"));
    if (limit > 0) budgets[category] = limit;
    else delete budgets[category];
    await this.gateway.setSetting(
      connection.spreadsheetId,
      "category_budgets_json",
      JSON.stringify(budgets),
    );
    this.invalidateDashboard(connection.spreadsheetId);
  }

  async getBudgetWarnings(chatId: string, category?: string): Promise<string[]> {
    const budgets = await this.getBudgetStatus(chatId);
    const warnings: string[] = [];
    if (budgets.daily && budgets.daily.percent >= 80) {
      warnings.push(
        budgets.daily.percent >= 100
          ? `⚠ Дневной бюджет превышен на ${formatPlainAmount(-budgets.daily.remaining)} ${budgets.baseCurrency}.`
          : `⚠ Использовано ${Math.round(budgets.daily.percent)}% дневного бюджета.`,
      );
    }
    const categoryBudget = budgets.categories.find((item) => item.category === category);
    if (categoryBudget && categoryBudget.percent >= 80) {
      warnings.push(
        categoryBudget.percent >= 100
          ? `⚠ Бюджет «${categoryBudget.category}» превышен на ${formatPlainAmount(-categoryBudget.remaining)} ${budgets.baseCurrency}.`
          : `⚠ Использовано ${Math.round(categoryBudget.percent)}% бюджета «${categoryBudget.category}».`,
      );
    }
    return warnings;
  }

  async setDigestEnabled(chatId: string, enabled: boolean): Promise<void> {
    const connection = await this.requireConnection(chatId);
    await this.gateway.setSetting(
      connection.spreadsheetId,
      "daily_digest_enabled",
      enabled ? "true" : "false",
    );
    this.invalidateDashboard(connection.spreadsheetId);
  }

  async setDigestTime(chatId: string, time: string): Promise<string> {
    const normalized = validDigestTime(time.trim());
    if (!normalized) throw new UserFacingError("Нужно время в формате ЧЧ:ММ, например 21:00.");
    const connection = await this.requireConnection(chatId);
    await this.gateway.setSetting(connection.spreadsheetId, "daily_digest_time", normalized);
    this.invalidateDashboard(connection.spreadsheetId);
    return normalized;
  }

  async getDigestSettings(chatId: string): Promise<{ enabled: boolean; time: string; timezone: string }> {
    const dashboard = await this.getDashboard(chatId);
    return { ...dashboard.digest, timezone: dashboard.localTimezone };
  }

  async getDueDigests(now = new Date()): Promise<DigestDelivery[]> {
    const active = await this.stateStore.getActiveChatConnections();
    const deliveries = await Promise.all(active.map(async ({ chatId, connection }) => {
      try {
        const sync = await this.gateway.syncManualMoneyTransactions(
          connection.spreadsheetId,
          chatId,
        );
        if (sync.imported || sync.updated || sync.deleted) {
          this.invalidateDashboard(connection.spreadsheetId);
        }
        const dashboard = await this.getDashboard(chatId);
        if (!dashboard.digest.enabled) return null;
        const localDate = dateInTimezone(now, dashboard.localTimezone);
        const localTime = timeInTimezone(now, dashboard.localTimezone);
        if (localTime < dashboard.digest.time) return null;
        const lastSent = await this.stateStore.getDigestLastSent(
          chatId,
          connection.spreadsheetId,
        );
        if (lastSent && formatDate(lastSent) === localDate) return null;
        return {
          chatId,
          spreadsheetId: connection.spreadsheetId,
          localDate,
          title: dashboard.connection.title,
          baseCurrency: dashboard.baseCurrency,
          todaySpent: dashboard.today.lines.reduce((sum, line) => sum + line.amountBase, 0),
          balances: dashboard.balances,
          budgets: dashboard.budgets,
        } satisfies DigestDelivery;
      } catch (error) {
        console.error(`Не удалось подготовить digest для чата ${chatId}:`, error);
        return null;
      }
    }));
    return deliveries.filter((item): item is DigestDelivery => item !== null);
  }

  markDigestSent(delivery: Pick<DigestDelivery, "chatId" | "spreadsheetId" | "localDate">): Promise<void> {
    return this.stateStore.setDigestLastSent(
      delivery.chatId,
      delivery.spreadsheetId,
      delivery.localDate,
    );
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
    const timezone = settings.get("home_timezone") || "Europe/Moscow";
    return HOME_TIMEZONES.has(timezone) ? timezone : "Europe/Moscow";
  }

  async getLocalTimezone(chatId: string): Promise<string> {
    const connection = await this.requireConnection(chatId);
    const settings = await this.gateway.getSettings(connection.spreadsheetId);
    return settings.get("timezone") || this.config.defaultTimezone;
  }

  async setHomeTimezone(chatId: string, timezone: string): Promise<string> {
    const normalized = validateTimezone(timezone);
    const connection = await this.requireConnection(chatId);
    await this.gateway.setSetting(connection.spreadsheetId, "home_timezone", normalized);
    this.invalidateDashboard(connection.spreadsheetId);
    return normalized;
  }

  async setLocalTimezone(chatId: string, timezone: string): Promise<string> {
    const normalized = validateTimezone(timezone);
    const connection = await this.requireConnection(chatId);
    await this.gateway.setSetting(connection.spreadsheetId, "timezone", normalized);
    await this.gateway.refreshOverview(connection.spreadsheetId);
    this.invalidateDashboard(connection.spreadsheetId);
    return normalized;
  }

  async setBaseCurrency(chatId: string, currency: string): Promise<string> {
    const normalized = normalizeCurrencyCode(currency);
    if (!normalized) {
      throw new UserFacingError("Не узнаю валюту. Отправь ISO-код, например GBP, AED или KZT.");
    }
    const connection = await this.requireConnection(chatId);
    const settings = await this.gateway.getSettings(connection.spreadsheetId);
    const rubRate = currencyRubRateFromSettings(settings, normalized);
    if (!rubRate) {
      throw new UserFacingError(
        `Сначала укажи, сколько RUB стоит 1 ${normalized}.`,
      );
    }
    await Promise.all([
      this.gateway.setSetting(connection.spreadsheetId, "base_currency", normalized),
      this.gateway.setSetting(
        connection.spreadsheetId,
        "base_currency_rub_rate",
        rubRate,
      ),
    ]);
    await this.gateway.refreshOverview(connection.spreadsheetId);
    this.invalidateDashboard(connection.spreadsheetId);
    return normalized;
  }

  async getCurrencyRubRate(chatId: string, currency: string): Promise<number | null> {
    const normalized = normalizeCurrencyCode(currency);
    if (!normalized) return null;
    const connection = await this.requireConnection(chatId);
    return currencyRubRateFromSettings(
      await this.gateway.getSettings(connection.spreadsheetId),
      normalized,
    );
  }

  async setCurrencyRubRate(
    chatId: string,
    currency: string,
    rubRate: number,
  ): Promise<void> {
    const normalized = normalizeCurrencyCode(currency);
    if (!normalized || !Number.isFinite(rubRate) || rubRate <= 0) {
      throw new UserFacingError("Курс должен быть положительным числом.");
    }
    const connection = await this.requireConnection(chatId);
    await this.storeCurrencyRubRate(connection.spreadsheetId, normalized, rubRate);
    await this.gateway.refreshOverview(connection.spreadsheetId);
    this.invalidateDashboard(connection.spreadsheetId);
  }

  async setRate(
    chatId: string,
    currency: "USD" | "JPY",
    rubRate: number,
  ): Promise<void> {
    const connection = await this.requireConnection(chatId);
    await this.storeCurrencyRubRate(connection.spreadsheetId, currency, rubRate);
    this.invalidateDashboard(connection.spreadsheetId);
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
    const currencyRates = currencyRatesFromSettings(settings);
    const purchaseRate = rubRateForCurrency(purchaseCurrency, rates, undefined, currencyRates);
    const accountRate = rubRateForCurrency(account.currency, rates, account.rubRate, currencyRates);
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
    const rates = input.rates ?? ratesFromSettings(settings);
    const converted = convertAmounts({
      purchaseAmount: input.purchaseAmount,
      purchaseCurrency: input.purchaseCurrency,
      accountAmount: input.accountAmount,
      accountCurrency: account.currency,
      accountRubRate: input.accountRubRate ??
        rubRateForCurrency(account.currency, rates, account.rubRate) ??
        account.rubRate,
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
      date: formatDate(input.date ?? dateInTimezone(new Date(), timezone)),
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
      moneySyncStatus: input.type === "expense" ? "pending" : "not_applicable",
      moneySyncError: "",
      moneySyncedAt: "",
      transferId: "",
    };
    await this.gateway.appendTransaction(connection.spreadsheetId, transaction);
    this.invalidateDashboard(connection.spreadsheetId);
    return transaction;
  }

  async recordTransfer(input: NewTransferInput): Promise<RecordedTransfer> {
    if (input.sourceAccountId === input.destinationAccountId) {
      throw new UserFacingError("Для перевода нужны два разных счёта.");
    }
    if (input.sourceAmount <= 0 || input.destinationAmount <= 0) {
      throw new UserFacingError("Суммы перевода должны быть больше нуля.");
    }
    const connection = await this.requireConnection(input.chatId);
    const [accounts, settings] = await Promise.all([
      this.gateway.getAccounts(connection.spreadsheetId),
      this.gateway.getSettings(connection.spreadsheetId),
    ]);
    const sourceAccount = accounts.find((account) => account.id === input.sourceAccountId);
    const destinationAccount = accounts.find(
      (account) => account.id === input.destinationAccountId,
    );
    if (!sourceAccount || !destinationAccount) {
      throw new UserFacingError("Один из счетов перевода больше не найден.");
    }
    const rates = input.rates ?? ratesFromSettings(settings);
    const convertedSource = convertAmounts({
      purchaseAmount: input.sourceAmount,
      purchaseCurrency: sourceAccount.currency,
      accountAmount: input.sourceAmount,
      accountCurrency: sourceAccount.currency,
      accountRubRate: rubRateForCurrency(sourceAccount.currency, rates, sourceAccount.rubRate) ?? sourceAccount.rubRate,
      rates,
    });
    const convertedDestination = convertAmounts({
      purchaseAmount: input.destinationAmount,
      purchaseCurrency: destinationAccount.currency,
      accountAmount: input.destinationAmount,
      accountCurrency: destinationAccount.currency,
      accountRubRate: rubRateForCurrency(destinationAccount.currency, rates, destinationAccount.rubRate) ?? destinationAccount.rubRate,
      rates,
    });
    if (convertedSource.amountRub === null || convertedDestination.amountRub === null) {
      throw new UserFacingError("Не хватает курса одного из счетов для записи перевода.");
    }
    const transferId = `tr_${randomUUID().slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    const timezone = settings.get("timezone") || this.config.defaultTimezone;
    const date = formatDate(input.date ?? dateInTimezone(new Date(), timezone));
    const isExchange = sourceAccount.currency !== destinationAccount.currency;
    const category = isExchange ? "Обмен" : "Перевод";
    const description = input.description.trim() ||
      `${category}: ${sourceAccount.name} → ${destinationAccount.name}`;
    const common = {
      createdAt,
      date,
      category,
      description,
      telegramUser: input.telegramUser,
      chatId: input.chatId,
      deletedAt: "",
      moneySyncStatus: "not_applicable" as const,
      moneySyncError: "",
      moneySyncedAt: "",
      transferId,
    };
    const source: TravelTransaction = {
      ...common,
      id: `tx_${randomUUID().slice(0, 12)}`,
      type: "transfer_out",
      accountId: sourceAccount.id,
      accountName: sourceAccount.name,
      amount: input.sourceAmount,
      currency: sourceAccount.currency,
      purchaseAmount: input.sourceAmount,
      purchaseCurrency: sourceAccount.currency,
      ...convertedSource,
    };
    const destination: TravelTransaction = {
      ...common,
      id: `tx_${randomUUID().slice(0, 12)}`,
      type: "transfer_in",
      accountId: destinationAccount.id,
      accountName: destinationAccount.name,
      amount: input.destinationAmount,
      currency: destinationAccount.currency,
      purchaseAmount: input.destinationAmount,
      purchaseCurrency: destinationAccount.currency,
      ...convertedDestination,
    };
    await this.gateway.appendTransferTransactions(
      connection.spreadsheetId,
      [source, destination],
    );
    this.invalidateDashboard(connection.spreadsheetId);
    return { source, destination };
  }

  async replaceTransfer(
    transferId: string,
    input: NewTransferInput,
  ): Promise<RecordedTransfer> {
    const connection = await this.requireConnection(input.chatId);
    const original = await this.getTransferPair(input.chatId, transferId);
    const replacement = await this.recordTransfer({
      ...input,
      date: original.source.date,
      rates: {
        usdRub: original.source.usdRubRate ?? original.destination.usdRubRate,
        jpyRub: original.source.jpyRubRate ?? original.destination.jpyRubRate,
      },
    });
    try {
      await this.gateway.markTransactionsDeleted(
        connection.spreadsheetId,
        [original.source, original.destination],
        new Date().toISOString(),
      );
    } catch (error) {
      try {
        const storedReplacement = await this.getTransferPair(
          input.chatId,
          replacement.source.transferId,
        );
        await this.gateway.markTransactionsDeleted(
          connection.spreadsheetId,
          [storedReplacement.source, storedReplacement.destination],
          new Date().toISOString(),
        );
      } catch (rollbackError) {
        console.error("Не удалось откатить заменяющий перевод:", rollbackError);
      }
      throw error;
    }
    return replacement;
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
    const baseRubRate = currencyRubRateFromSettings(settings, baseCurrency);
    return {
      date,
      baseCurrency,
      lines: summarizeExpenses(transactions, baseCurrency, date, baseRubRate),
    };
  }

  async getParticipantSummary(chatId: string, todayOnly: boolean) {
    const connection = await this.requireConnection(chatId);
    const [transactions, settings] = await Promise.all([
      this.gateway.getTransactions(connection.spreadsheetId),
      this.gateway.getSettings(connection.spreadsheetId),
    ]);
    const timezone = settings.get("timezone") || this.config.defaultTimezone;
    const baseCurrency = (settings.get("base_currency") || "RUB").toUpperCase();
    const date = todayOnly ? dateInTimezone(new Date(), timezone) : undefined;
    const baseRubRate = currencyRubRateFromSettings(settings, baseCurrency);
    return {
      date,
      baseCurrency,
      lines: summarizeExpensesByParticipant(transactions, baseCurrency, date, baseRubRate),
    };
  }

  async getRecentTransactions(chatId: string, limit = 10): Promise<StoredTransaction[]> {
    const connection = await this.requireConnection(chatId);
    const transactions = await this.gateway.getTransactions(connection.spreadsheetId);
    return transactions
      .filter((transaction) =>
        transaction.chatId === chatId &&
        !transaction.deletedAt &&
        transaction.type !== "transfer_in"
      )
      .reverse()
      .slice(0, limit);
  }

  async getTransaction(chatId: string, transactionId: string): Promise<StoredTransaction> {
    const connection = await this.requireConnection(chatId);
    const transactions = await this.gateway.getTransactions(connection.spreadsheetId);
    const transaction = transactions.find(
      (candidate) =>
        candidate.id === transactionId &&
        candidate.chatId === chatId &&
        !candidate.deletedAt,
    );
    if (!transaction) throw new UserFacingError("Операция не найдена или уже отменена.");
    return transaction;
  }

  async repeatTransaction(
    chatId: string,
    transactionId: string,
    telegramUser: string,
  ): Promise<TravelTransaction> {
    const original = await this.getTransaction(chatId, transactionId);
    if (original.transferId) {
      const pair = await this.getTransferPair(chatId, original.transferId);
      const repeated = await this.recordTransfer({
        chatId,
        sourceAccountId: pair.source.accountId,
        destinationAccountId: pair.destination.accountId,
        sourceAmount: pair.source.amount,
        destinationAmount: pair.destination.amount,
        description: pair.source.description,
        telegramUser,
      });
      return repeated.source;
    }
    if (original.type !== "expense" && original.type !== "income") {
      throw new UserFacingError("Не удалось определить связанную часть перевода.");
    }
    return this.recordTransaction({
      chatId,
      type: original.type,
      accountId: original.accountId,
      accountAmount: original.amount,
      purchaseAmount: original.purchaseAmount,
      purchaseCurrency: original.purchaseCurrency,
      category: original.category,
      description: original.description,
      telegramUser,
    });
  }

  async replaceTransaction(
    chatId: string,
    transactionId: string,
    changes: TransactionChanges,
    telegramUser: string,
  ): Promise<TravelTransaction> {
    const connection = await this.requireConnection(chatId);
    const original = await this.getTransaction(chatId, transactionId);
    if (original.transferId) {
      throw new UserFacingError("Перевод можно повторить или отменить и создать заново.");
    }
    if (original.type !== "expense" && original.type !== "income") {
      throw new UserFacingError("Эту операцию нельзя исправить как обычный расход.");
    }
    const replacement = await this.recordTransaction({
      chatId,
      type: original.type,
      accountId: changes.accountId ?? original.accountId,
      accountAmount: changes.accountAmount ?? original.amount,
      purchaseAmount: changes.purchaseAmount ?? original.purchaseAmount,
      purchaseCurrency: changes.purchaseCurrency ?? original.purchaseCurrency,
      category: changes.category ?? original.category,
      description: changes.description ?? original.description,
      telegramUser,
      date: original.date,
      rates: {
        usdRub: original.usdRubRate,
        jpyRub: original.jpyRubRate,
      },
      accountRubRate: changes.accountId && changes.accountId !== original.accountId
        ? undefined
        : original.amount > 0 && original.amountRub !== null
          ? original.amountRub / original.amount
          : undefined,
    });
    try {
      await this.gateway.markTransactionDeleted(
        connection.spreadsheetId,
        original,
        new Date().toISOString(),
      );
    } catch (error) {
      try {
        const storedReplacement = (await this.gateway.getTransactions(connection.spreadsheetId))
          .find((candidate) => candidate.id === replacement.id && !candidate.deletedAt);
        if (storedReplacement) {
          await this.gateway.markTransactionDeleted(
            connection.spreadsheetId,
            storedReplacement,
            new Date().toISOString(),
          );
        }
      } catch (rollbackError) {
        console.error("Не удалось откатить заменяющую операцию:", rollbackError);
      }
      throw error;
    }
    return replacement;
  }

  async undoTransaction(chatId: string, transactionId: string): Promise<TravelTransaction> {
    const connection = await this.requireConnection(chatId);
    const transaction = await this.getTransaction(chatId, transactionId);
    if (transaction.transferId) {
      const pair = await this.getTransferPair(chatId, transaction.transferId);
      await this.gateway.markTransactionsDeleted(
        connection.spreadsheetId,
        [pair.source, pair.destination],
        new Date().toISOString(),
      );
      this.invalidateDashboard(connection.spreadsheetId);
      return pair.source;
    }
    await this.gateway.markTransactionDeleted(
      connection.spreadsheetId,
      transaction,
      new Date().toISOString(),
    );
    this.invalidateDashboard(connection.spreadsheetId);
    return transaction;
  }

  async getTransferPair(
    chatId: string,
    transferId: string,
  ): Promise<{ source: StoredTransaction; destination: StoredTransaction }> {
    const connection = await this.requireConnection(chatId);
    const pair = (await this.gateway.getTransactions(connection.spreadsheetId))
      .filter((transaction) =>
        transaction.transferId === transferId &&
        transaction.chatId === chatId &&
        !transaction.deletedAt
      );
    const source = pair.find((transaction) => transaction.type === "transfer_out");
    const destination = pair.find((transaction) => transaction.type === "transfer_in");
    if (!source || !destination) {
      throw new UserFacingError("Связанные части перевода не найдены.");
    }
    return { source, destination };
  }

  async undoLast(chatId: string): Promise<TravelTransaction | null> {
    const connection = await this.requireConnection(chatId);
    const transactions = await this.gateway.getTransactions(connection.spreadsheetId);
    const latest = [...transactions]
      .reverse()
      .find((transaction) => transaction.chatId === chatId && !transaction.deletedAt);
    if (!latest) return null;
    return this.undoTransaction(chatId, latest.id);
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

  private invalidateDashboard(spreadsheetId: string): void {
    this.dashboardCache.delete(spreadsheetId);
  }

  private async storeCurrencyRubRate(
    spreadsheetId: string,
    currency: string,
    rubRate: number,
  ): Promise<void> {
    const settings = await this.gateway.getSettings(spreadsheetId);
    const normalized = currency.toUpperCase();
    const currencyRates = currencyRatesFromSettings(settings);
    currencyRates[normalized] = normalized === "RUB" ? 1 : rubRate;
    const updates = [
      this.gateway.setSetting(
        spreadsheetId,
        "currency_rates_json",
        JSON.stringify(currencyRates),
      ),
      this.gateway.updateAccountRates(spreadsheetId, normalized, currencyRates[normalized]!),
    ];
    if (normalized === "USD" || normalized === "JPY") {
      updates.push(this.gateway.setSetting(
        spreadsheetId,
        normalized === "USD" ? "usd_rub_rate" : "jpy_rub_rate",
        String(currencyRates[normalized]),
      ));
    }
    if ((settings.get("base_currency") || "RUB").toUpperCase() === normalized) {
      updates.push(this.gateway.setSetting(
        spreadsheetId,
        "base_currency_rub_rate",
        currencyRates[normalized]!,
      ));
    }
    await Promise.all(updates);
  }
}

function ratesFromSettings(settings: Map<string, string>): ExchangeRates {
  return {
    usdRub: positiveSetting(settings.get("usd_rub_rate")),
    jpyRub: positiveSetting(settings.get("jpy_rub_rate")),
  };
}

function currencyRatesFromSettings(settings: Map<string, string>): Record<string, number> {
  const result: Record<string, number> = { RUB: 1 };
  try {
    const parsed = JSON.parse(settings.get("currency_rates_json") || "{}") as Record<string, unknown>;
    for (const [currency, value] of Object.entries(parsed)) {
      if (/^[A-Z]{3}$/.test(currency) && typeof value === "number" && value > 0) {
        result[currency] = value;
      }
    }
  } catch {
    // Invalid optional settings are ignored; dedicated USD/JPY values still work.
  }
  const usdRub = positiveSetting(settings.get("usd_rub_rate"));
  const jpyRub = positiveSetting(settings.get("jpy_rub_rate"));
  if (usdRub) result.USD = usdRub;
  if (jpyRub) result.JPY = jpyRub;
  return result;
}

function currencyRubRateFromSettings(
  settings: Map<string, string>,
  currency: string,
): number | null {
  const normalized = currency.toUpperCase();
  const configured = currencyRatesFromSettings(settings)[normalized];
  if (configured) return configured;
  if ((settings.get("base_currency") || "").toUpperCase() === normalized) {
    return positiveSetting(settings.get("base_currency_rub_rate"));
  }
  return null;
}

function buildBudgetStatus(
  transactions: StoredTransaction[],
  settings: Map<string, string>,
  baseCurrency: string,
  date: string,
  baseRubRate: number | null,
): BudgetStatus {
  const dailyLimit = positiveSetting(settings.get("daily_budget"));
  const dailySpent = summarizeExpenses(transactions, baseCurrency, date, baseRubRate)
    .reduce((sum, line) => sum + line.amountBase, 0);
  const allByCategory = new Map(
    summarizeExpenses(transactions, baseCurrency, undefined, baseRubRate)
      .map((line) => [line.label, line.amountBase]),
  );
  return {
    baseCurrency,
    daily: dailyLimit ? budgetProgress(dailySpent, dailyLimit) : null,
    categories: Object.entries(parseCategoryBudgets(settings.get("category_budgets_json")))
      .map(([category, limit]) => ({
        category,
        ...budgetProgress(allByCategory.get(category) ?? 0, limit),
      }))
      .sort((left, right) => right.percent - left.percent),
  };
}

function budgetProgress(spent: number, limit: number): BudgetProgress {
  return {
    limit,
    spent,
    remaining: limit - spent,
    percent: limit > 0 ? (spent / limit) * 100 : 0,
  };
}

function parseCategoryBudgets(value: string | undefined): Record<string, number> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
      ),
    );
  } catch {
    return {};
  }
}

function formatPlainAmount(amount: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(amount);
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
  currencyRates: Record<string, number> = {},
): number | null {
  if (currency.toUpperCase() === "RUB") return 1;
  if (currency.toUpperCase() === "USD") return rates.usdRub ?? accountRate ?? null;
  if (currency.toUpperCase() === "JPY") return rates.jpyRub ?? accountRate ?? null;
  const configured = currencyRates[currency.toUpperCase()];
  if (configured && configured > 0) return configured;
  return accountRate && accountRate > 0 ? accountRate : null;
}

export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch?.[1]) return urlMatch[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}

function timeInTimezone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function validDigestTime(value: string | undefined): string | null {
  return value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

function validateTimezone(timezone: string): string {
  const normalized = timezone.trim();
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: normalized }).format(new Date());
  } catch {
    throw new UserFacingError("Не узнаю этот часовой пояс. Пример: Europe/Moscow.");
  }
  return normalized;
}
