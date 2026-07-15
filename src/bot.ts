import { randomUUID } from "node:crypto";
import {
  Bot,
  Context,
  InlineKeyboard,
  session,
  type SessionFlavor,
} from "grammy";
import {
  findCategory,
  findNamedItem,
  OpenAINaturalInput,
  type NaturalCommand,
} from "./ai/naturalInput.js";
import type { AppConfig } from "./config.js";
import { normalizeCurrencyCode } from "./domain/currency.js";
import { formatDate } from "./domain/date.js";
import {
  calculateUsdJpyRate,
  formatMoney,
  parseAmount,
  parseSignedAmount,
} from "./domain/money.js";
import type {
  AccountBalance,
  AccountKind,
  DirectTransactionType,
  StoredTransaction,
  TravelTransaction,
} from "./domain/types.js";
import {
  TravelService,
  UserFacingError,
  type RecordOperationIds,
  type RecordedTransfer,
} from "./services/travelService.js";

export const BOT_COMMANDS = [
  { command: "start", description: "Открыть панель" },
  { command: "expense", description: "Новый расход" },
  { command: "income", description: "Пополнить счёт" },
  { command: "accounts", description: "Счета и остатки" },
  { command: "summary", description: "Сводка расходов" },
  { command: "participants", description: "Расходы участников" },
  { command: "recent", description: "Последние операции" },
  { command: "transfer", description: "Перевод или обмен" },
  { command: "trips", description: "Мои поездки" },
  { command: "help", description: "Как всё устроено" },
] as const;

type Flow =
  | { kind: "idle" }
  | { kind: "connect_url" }
  | {
      kind: "transaction_currency";
      accountId: string;
      accountName: string;
      accountCurrency: string;
    }
  | {
      kind: "transaction_purchase_amount";
      accountId: string;
      accountName: string;
      accountCurrency: string;
      purchaseCurrency: string;
    }
  | {
      kind: "transaction_account_amount";
      accountId: string;
      accountName: string;
      accountCurrency: string;
      purchaseAmount: number;
      purchaseCurrency: string;
    }
  | {
      kind: "transaction_income_amount";
      accountId: string;
      accountName: string;
      accountCurrency: string;
    }
  | {
      kind: "transaction_category";
      accountId: string;
      accountName: string;
      accountCurrency: string;
      accountAmount: number;
      purchaseAmount: number;
      purchaseCurrency: string;
      categories: string[];
    }
  | {
      kind: "transaction_description";
      type: DirectTransactionType;
      accountId: string;
      accountAmount: number;
      purchaseAmount: number;
      purchaseCurrency: string;
      category: string;
      transactionId?: string;
      description?: string;
    }
  | { kind: "account_kind" }
  | { kind: "account_name"; accountKind: AccountKind }
  | { kind: "account_currency"; accountKind: AccountKind; name: string }
  | { kind: "account_opening"; accountKind: AccountKind; name: string; currency: string }
  | {
      kind: "account_rate";
      accountKind: AccountKind;
      name: string;
      currency: string;
      openingBalance: number;
    }
  | { kind: "rate_value"; currency: "USD" | "JPY" }
  | { kind: "base_currency_code" }
  | { kind: "base_currency_rate"; currency: string }
  | { kind: "local_timezone" }
  | { kind: "budget_daily" }
  | { kind: "budget_category_value"; category: string }
  | { kind: "digest_time" }
  | { kind: "natural_account"; command: NaturalCommand }
  | {
      kind: "natural_retry";
      command: NaturalCommand;
      forcedAccountId?: string;
      operationIds: RecordOperationIds;
    }
  | {
      kind: "quick_record_retry";
      action: "repeat" | "favorite";
      referenceId: string;
      operationIds: RecordOperationIds;
    }
  | { kind: "history_edit_amount"; transactionId: string; replacementTransactionId: string }
  | { kind: "history_edit_description"; transactionId: string; replacementTransactionId: string }
  | { kind: "history_edit_category"; transactionId: string; replacementTransactionId: string; categories: string[] }
  | { kind: "history_edit_account"; transactionId: string; replacementTransactionId: string }
  | { kind: "transfer_source"; replaceTransferId?: string }
  | { kind: "transfer_destination"; sourceAccountId: string; replaceTransferId?: string }
  | {
      kind: "transfer_source_amount";
      sourceAccountId: string;
      sourceAccountName: string;
      sourceCurrency: string;
      destinationAccountId: string;
      destinationAccountName: string;
      destinationCurrency: string;
      replaceTransferId?: string;
      operationIds?: RecordOperationIds["transfer"];
    }
  | {
      kind: "transfer_destination_amount";
      sourceAccountId: string;
      sourceAccountName: string;
      sourceCurrency: string;
      destinationAccountId: string;
      destinationAccountName: string;
      destinationCurrency: string;
      sourceAmount: number;
      replaceTransferId?: string;
      operationIds?: RecordOperationIds["transfer"];
    }
  | {
      kind: "transfer_ready";
      sourceAccountId: string;
      sourceAccountName: string;
      sourceCurrency: string;
      destinationAccountId: string;
      destinationAccountName: string;
      destinationCurrency: string;
      sourceAmount: number;
      destinationAmount: number;
      replaceTransferId?: string;
      operationIds: RecordOperationIds["transfer"];
    };

interface BotSession {
  flow: Flow;
  screenMessageId?: number;
  forceNewScreen?: boolean;
}

interface PausedFlowScreen {
  text: string;
  inlineKeyboard: InlineKeyboard["inline_keyboard"];
}

type FlowWithPausedScreen = Flow & { pausedScreen?: PausedFlowScreen };

function getPausedScreen(flow: Flow): PausedFlowScreen | undefined {
  return (flow as FlowWithPausedScreen).pausedScreen;
}

function pauseFlow(flow: Flow, screen: PausedFlowScreen): Flow {
  return { ...flow, pausedScreen: screen } as unknown as Flow;
}

function resumeFlow(flow: Flow): Flow {
  const { pausedScreen: _pausedScreen, ...activeFlow } = flow as FlowWithPausedScreen;
  return activeFlow as Flow;
}

function isPersistedFlow(value: unknown): value is Flow {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && kind !== "idle";
}

type BotContext = Context & SessionFlavor<BotSession>;

const HOME_TIMEZONES = [
  { label: "Москва", timezone: "Europe/Moscow" },
  { label: "Дубай", timezone: "Asia/Dubai" },
  { label: "Токио", timezone: "Asia/Tokyo" },
] as const;

const LOCAL_TIMEZONES = [
  { label: "Сидней", timezone: "Australia/Sydney" },
  { label: "Нью-Йорк", timezone: "America/New_York" },
  { label: "Токио", timezone: "Asia/Tokyo" },
  { label: "Лондон", timezone: "Europe/London" },
] as const;

type TimezoneOption = { readonly label: string; readonly timezone: string };

function mainMenu(hasDraft = false): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasDraft) {
    keyboard
      .text("↩ Продолжить черновик", "flow:resume")
      .text("× Сбросить", "flow:cancel")
      .row();
  }
  return keyboard
    .text("＋ Расход", "menu:expense")
    .text("＋ Пополнение", "menu:income")
    .row()
    .text("◉ Счета", "menu:accounts")
    .text("▥ Сводка", "menu:summary")
    .row()
    .text("◷ Операции", "menu:recent")
    .text("⇄ Перевод", "menu:transfer")
    .row()
    .text("★ Быстро", "menu:favorites")
    .text("✈ Поездки", "menu:trips")
    .row()
    .text("⚙ Настройки", "menu:settings")
    .row()
    .text("↶ Отменить последнюю операцию", "menu:undo");
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("← Назад", "flow:back")
    .row()
    .text("× Отменить", "flow:cancel");
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⌂ Главная", "menu:home");
}

function descriptionKeyboard(defaultName?: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(defaultName ? `Оставить «${defaultName}»` : "Без комментария", "tx:skip")
    .row()
    .text("← Назад", "flow:back")
    .row()
    .text("× Отменить", "flow:cancel");
}

function timezoneKeyboard(
  currentTimezone: string,
  options: readonly TimezoneOption[],
  callbackPrefix: "settings:home" | "settings:local",
  allowCustom = true,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  options.forEach((item, index) => {
    const prefix = item.timezone === currentTimezone ? "✓ " : "";
    keyboard.text(`${prefix}${item.label}`, `${callbackPrefix}:${index}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (allowCustom) keyboard.row().text("Другой город", `${callbackPrefix}:custom`);
  keyboard.row().text("← Назад", "menu:settings");
  return keyboard;
}

function timezoneLabel(timezone: string, options: readonly TimezoneOption[]): string {
  return options.find((item) => item.timezone === timezone)?.label ?? timezone;
}

function formatTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date());
  } catch {
    return "--:--";
  }
}

function baseCurrencyKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("USD", "settings:base:USD")
    .text("EUR", "settings:base:EUR")
    .row()
    .text("Другая валюта", "settings:base:custom")
    .row()
    .text("← Назад", "menu:settings");
}

function telegramUser(ctx: BotContext): string {
  if (ctx.from?.username) return `@${ctx.from.username}`;
  return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "unknown";
}

function chatId(ctx: BotContext): string {
  if (!ctx.chat) throw new UserFacingError("Не удалось определить Telegram-чат.");
  return String(ctx.chat.id);
}

function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function compactTitle(title: string): string {
  return title.length > 38 ? `${title.slice(0, 35)}...` : title;
}

function createTransactionId(): string {
  return `tx_${randomUUID().slice(0, 12)}`;
}

function createTransferOperationIds(): RecordOperationIds["transfer"] {
  return {
    transferId: `tr_${randomUUID().slice(0, 12)}`,
    sourceTransactionId: createTransactionId(),
    destinationTransactionId: createTransactionId(),
  };
}

function operationIdsForUpdate(ctx: BotContext): RecordOperationIds {
  const updateId = ctx.update.update_id.toString(36);
  return {
    transactionId: `tx_u${updateId}`,
    transfer: {
      transferId: `tr_u${updateId}`,
      sourceTransactionId: `tx_u${updateId}_out`,
      destinationTransactionId: `tx_u${updateId}_in`,
    },
  };
}

function formatRate(rate: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 }).format(rate);
}

async function showScreen(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard = mainMenu(),
): Promise<void> {
  const callbackData = keyboard.inline_keyboard.flatMap((row) =>
    row.flatMap((button) => "callback_data" in button ? [button.callback_data] : [])
  );
  const isMainMenu = callbackData.includes("menu:expense");
  const isConnectOnly = callbackData.length > 0 &&
    callbackData.every((callback) => callback === "trip:connect");
  const hasHome = callbackData.some((callback) =>
    callback === "menu:home" || callback === "flow:home"
  );
  if (!isMainMenu && !isConnectOnly && !hasHome) {
    keyboard
      .row()
      .text(
        "⌂ Главная",
        isPersistedFlow(ctx.session.flow) ? "flow:home" : "menu:home",
      );
  }
  const callbackMessageId = ctx.callbackQuery?.message?.message_id;
  const targetMessageId = ctx.session.screenMessageId ?? callbackMessageId;
  if (
    callbackMessageId &&
    ctx.session.screenMessageId &&
    callbackMessageId !== ctx.session.screenMessageId &&
    ctx.chat
  ) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, callbackMessageId);
    } catch {
      // Old duplicate panels are cleaned up opportunistically.
    }
  }
  if (targetMessageId && ctx.chat && !ctx.session.forceNewScreen) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, targetMessageId, text, {
        reply_markup: keyboard,
      });
      ctx.session.screenMessageId = targetMessageId;
      return;
    } catch (error) {
      if (String(error).includes("message is not modified")) return;
    }
  }
  if (targetMessageId && ctx.chat) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, targetMessageId);
    } catch {
      // The replacement can still be sent if an old panel is no longer deletable.
    }
  }
  const message = await ctx.reply(text, { reply_markup: keyboard });
  ctx.session.screenMessageId = message.message_id;
}

async function deleteIncomingMessage(ctx: BotContext): Promise<void> {
  if (!ctx.message || !ctx.chat || ctx.chat.type !== "private") return;
  try {
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
  } catch {
    // Cleanup is best-effort: the bot remains usable if Telegram refuses deletion.
  }
}

function shouldDeleteIncomingMessage(ctx: BotContext): boolean {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) return false;
  return [
    "connect_url",
    "transaction_income_amount",
    "transaction_purchase_amount",
    "transaction_account_amount",
    "transfer_source_amount",
    "transfer_destination_amount",
    "history_edit_amount",
    "account_currency",
    "account_opening",
    "account_rate",
    "rate_value",
    "base_currency_code",
    "base_currency_rate",
    "budget_daily",
    "budget_category_value",
    "digest_time",
  ].includes(ctx.session.flow.kind);
}

async function replyError(ctx: BotContext, error: unknown): Promise<void> {
  ctx.session.flow = { kind: "idle" };
  if (error instanceof UserFacingError) {
    await showScreen(ctx, error.message);
    return;
  }
  console.error(error);
  await showScreen(ctx, "Неожиданная ошибка. Подробности записаны в лог.");
}

export function createBot(
  config: AppConfig,
  service: TravelService,
  naturalInput = new OpenAINaturalInput(config),
): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.telegramBotToken);
  bot.use(session({ initial: (): BotSession => ({ flow: { kind: "idle" } }) }));

  bot.use(async (ctx, next) => {
    if (
      !config.allowPublicAccess &&
      (!ctx.from || !config.allowedTelegramUserIds.has(ctx.from.id))
    ) {
      await ctx.reply("У этого пользователя нет доступа к боту.");
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    if (!ctx.chat) {
      await next();
      return;
    }
    const id = String(ctx.chat.id);
    if (ctx.session.flow.kind === "idle") {
      const draft = await service.getBotDraft(id);
      if (isPersistedFlow(draft)) ctx.session.flow = draft;
    }
    const command = ctx.message?.text?.trim().split(/\s+/, 1)[0];
    if (
      ctx.callbackQuery?.data?.startsWith("menu:") ||
      (command?.startsWith("/") && !command.startsWith("/skip"))
    ) {
      ctx.session.flow = { kind: "idle" };
    }
    await next();
    if (ctx.session.flow.kind === "idle") await service.clearBotDraft(id);
    else await service.setBotDraft(id, ctx.session.flow);
  });

  bot.use(async (ctx, next) => {
    if (!ctx.chat) {
      await next();
      return;
    }
    const persistedMessageId = await service.getScreenMessageId(String(ctx.chat.id));
    if (!ctx.session.screenMessageId && persistedMessageId) {
      ctx.session.screenMessageId = persistedMessageId;
    }
    const previousMessageId = ctx.session.screenMessageId;
    await next();
    if (
      ctx.session.screenMessageId &&
      ctx.session.screenMessageId !== previousMessageId
    ) {
      await service.setScreenMessageId(String(ctx.chat.id), ctx.session.screenMessageId);
    }
  });

  bot.use(async (ctx, next) => {
    const deleteIncoming = shouldDeleteIncomingMessage(ctx);
    ctx.session.forceNewScreen = Boolean(ctx.message) && !deleteIncoming;
    if (deleteIncoming) await deleteIncomingMessage(ctx);
    try {
      await next();
    } finally {
      ctx.session.forceNewScreen = false;
    }
  });

  async function syncManualMoneyNotice(ctx: BotContext): Promise<string> {
    const result = await service.syncManualMoney(chatId(ctx));
    const changes = [
      result.imported ? `добавлено ${result.imported}` : "",
      result.updated ? `обновлено ${result.updated}` : "",
      result.deleted ? `удалено ${result.deleted}` : "",
    ].filter(Boolean);
    const lines = changes.length ? [`↻ Money: ${changes.join(", ")}.`] : [];
    if (result.unresolved) {
      lines.push(
        `⚠ Не импортировано строк из Money: ${result.unresolved}. Проверь «Вид оплаты», сумму, дату и соответствующий счёт в боте.`,
      );
    }
    return lines.join("\n");
  }

  function combineNotices(...notices: string[]): string {
    return notices.filter(Boolean).join("\n");
  }

  async function sendMain(ctx: BotContext, notice = ""): Promise<void> {
    const connection = await service.getConnection(chatId(ctx));
    if (!connection) {
      await showScreen(
        ctx,
        `${notice ? `${notice}\n\n` : ""}Мои поездки\n\nПодключи первую таблицу, чтобы начать учёт.`,
        new InlineKeyboard().text("＋ Подключить таблицу", "trip:connect"),
      );
      return;
    }
    notice = combineNotices(notice, await syncManualMoneyNotice(ctx));
    const dashboard = await service.getDashboard(chatId(ctx));
    const { baseCurrency, balances, today, homeTimezone, localTimezone } = dashboard;
    const totals = today.lines.reduce(
      (result, line) => ({
        base: result.base + line.amountBase,
        rub: result.rub + line.amountRub,
      }),
      { base: 0, rub: 0 },
    );
    const todayLine = today.lines.length
      ? `Сегодня: ${formatMoney(totals.base, baseCurrency)}` +
        (baseCurrency === "RUB" ? "" : ` · ${formatMoney(totals.rub, "RUB")}`)
      : "Сегодня расходов нет";
    const balanceLines = balances.length
      ? balances.slice(0, 4).map((item) => `• ${item.name}: ${formatMoney(item.balance, item.currency)}`)
      : ["• Счета ещё не добавлены"];
    const dailyBudgetLine = dashboard.budgets.daily
      ? dashboard.budgets.daily.remaining >= 0
        ? `Бюджет дня: ${Math.round(dashboard.budgets.daily.percent)}% · осталось ${formatMoney(dashboard.budgets.daily.remaining, baseCurrency)}`
        : `⚠ Бюджет дня превышен на ${formatMoney(-dashboard.budgets.daily.remaining, baseCurrency)}`
      : null;
    const lines = [
      ...(notice ? [notice, ""] : []),
      `✈ ${dashboard.connection.title}`,
      `Дом · ${timezoneLabel(homeTimezone, HOME_TIMEZONES)}: ${formatTime(homeTimezone)}`,
      `На месте · ${timezoneLabel(localTimezone, LOCAL_TIMEZONES)}: ${formatTime(localTimezone)}`,
      todayLine,
      ...(dailyBudgetLine ? [dailyBudgetLine] : []),
      "",
      "Остатки",
      ...balanceLines,
      ...(balances.length > 4 ? [`• Ещё счетов: ${balances.length - 4}`] : []),
    ];
    await showScreen(ctx, lines.join("\n"), mainMenu(Boolean(getPausedScreen(ctx.session.flow))));
  }

  async function connectSpreadsheet(ctx: BotContext, input: string): Promise<void> {
    try {
      const connection = await service.connect(chatId(ctx), input);
      ctx.session.flow = { kind: "idle" };
      await showScreen(
        ctx,
        `Подключено: ${connection.title}.\n\nВыбери базовую валюту страны поездки:`,
        baseCurrencyKeyboard(),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function finishBaseCurrencySetup(ctx: BotContext, notice: string): Promise<void> {
    const accounts = await service.getAccounts(chatId(ctx));
    if (accounts.length) {
      await sendSettings(ctx, notice);
      return;
    }
    await showScreen(
      ctx,
      [
        notice,
        "",
        "Настройка поездки · 2/2",
        "Добавь первый счёт: карту, наличные или другой источник денег.",
      ].join("\n"),
      new InlineKeyboard()
        .text("＋ Добавить первый счёт", "account:add")
        .row()
        .text("Пока пропустить", "menu:home"),
    );
  }

  async function selectBaseCurrency(ctx: BotContext, input: string): Promise<void> {
    const currency = normalizeCurrencyCode(input);
    if (!currency) {
      ctx.session.flow = { kind: "base_currency_code" };
      await showScreen(
        ctx,
        "Не узнаю валюту. Отправь международный код из трёх букв, например GBP, AED или KZT. Можно также написать: евро, тенге, дирхам, фунт.",
        cancelKeyboard(),
      );
      return;
    }
    const rubRate = await service.getCurrencyRubRate(chatId(ctx), currency);
    if (rubRate) {
      await service.setBaseCurrency(chatId(ctx), currency);
      ctx.session.flow = { kind: "idle" };
      await finishBaseCurrencySetup(ctx, `✓ Базовая валюта изменена на ${currency}.`);
      return;
    }
    ctx.session.flow = { kind: "base_currency_rate", currency };
    await showScreen(
      ctx,
      `Для расчёта общей сводки нужен курс.\n\nСколько RUB стоит 1 ${currency}?`,
      cancelKeyboard(),
    );
  }

  async function startConnect(ctx: BotContext): Promise<void> {
    ctx.session.flow = { kind: "connect_url" };
    await showScreen(
      ctx,
      "Подключение поездки · 1/1\n\nОтправь ссылку на Google-таблицу.",
      cancelKeyboard(),
    );
  }

  async function sendTrips(ctx: BotContext): Promise<void> {
    try {
      const [connections, active] = await Promise.all([
        service.getConnections(chatId(ctx)),
        service.getConnection(chatId(ctx)),
      ]);
      const keyboard = new InlineKeyboard();
      for (const connection of connections) {
        const prefix = connection.spreadsheetId === active?.spreadsheetId ? "✓ " : "";
        keyboard
          .text(`${prefix}${compactTitle(connection.title)}`, `trip:select:${connection.spreadsheetId}`)
          .row();
      }
      keyboard.text("＋ Подключить таблицу", "trip:connect");
      if (active) {
        keyboard.row().url("↗ Открыть таблицу", spreadsheetUrl(active.spreadsheetId));
        keyboard.text("× Отключить", `trip:remove:${active.spreadsheetId}`);
      }
      keyboard.row().text("⌂ Главная", "menu:home");
      await showScreen(
        ctx,
        active ? `Поездки\n\nАктивна: ${active.title}` : "Поездки\n\nПодключённых таблиц пока нет.",
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function startAccountCreation(ctx: BotContext): Promise<void> {
    try {
      if (!(await service.getConnection(chatId(ctx)))) {
        throw new UserFacingError("Сначала подключи таблицу поездки.");
      }
      ctx.session.flow = { kind: "account_kind" };
      await showScreen(
        ctx,
        "Новый счёт · 1/4\n\nВыбери тип счёта.",
        new InlineKeyboard()
          .text("▣ Карта", "account:kind:card")
          .text("● Наличные", "account:kind:cash")
          .row()
          .text("Другое", "account:kind:other")
          .row()
          .text("← Назад", "flow:back")
          .row()
          .text("× Отменить", "flow:cancel"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendAccounts(ctx: BotContext, notice = ""): Promise<void> {
    try {
      notice = combineNotices(notice, await syncManualMoneyNotice(ctx));
      const [balances, connection] = await Promise.all([
        service.getBalances(chatId(ctx)),
        service.getConnection(chatId(ctx)),
      ]);
      const lines = balances.length
        ? balances.map((item) => `• ${item.name}\n  ${formatMoney(item.balance, item.currency)}`)
        : ["Счетов пока нет."];
      const keyboard = new InlineKeyboard()
        .text("＋ Добавить счёт", "account:add")
        .row()
        .text("⌂ Главная", "menu:home");
      await showScreen(
        ctx,
        [
          ...(notice ? [notice, ""] : []),
          `Счета\n${connection?.title ?? "Поездка"}`,
          "",
          ...lines,
        ].join("\n"),
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendSummary(ctx: BotContext, todayOnly: boolean): Promise<void> {
    try {
      const moneyNotice = await syncManualMoneyNotice(ctx);
      const [summary, connection] = await Promise.all([
        service.getSummary(chatId(ctx), todayOnly),
        service.getConnection(chatId(ctx)),
      ]);
      const showRub = summary.baseCurrency !== "RUB";
      const lines = summary.lines.map((line) =>
        `${line.label}: ${formatMoney(line.amountBase, line.baseCurrency)}` +
        (showRub ? ` · ${formatMoney(line.amountRub, "RUB")}` : ""),
      );
      const totals = summary.lines.reduce(
        (result, line) => ({
          base: result.base + line.amountBase,
          rub: result.rub + line.amountRub,
        }),
        { base: 0, rub: 0 },
      );
      const period = todayOnly
        ? `сегодня, ${formatDate(summary.date ?? "")}`
        : "вся поездка";
      const total = lines.length
        ? `\nИтого: ${formatMoney(totals.base, summary.baseCurrency)}` +
          (showRub ? ` · ${formatMoney(totals.rub, "RUB")}` : "")
        : "";
      const keyboard = new InlineKeyboard()
        .text(todayOnly ? "✓ Сегодня" : "Сегодня", "summary:today")
        .text(todayOnly ? "Вся поездка" : "✓ Вся поездка", "summary:all")
        .row()
        .text("По участникам", `participants:${todayOnly ? "today" : "all"}`)
        .row()
        .text("⌂ Главная", "menu:home");
      await showScreen(ctx, [
        ...(moneyNotice ? [moneyNotice, ""] : []),
        `Сводка · ${period}\n${connection?.title ?? "Поездка"}`,
        "",
        ...(lines.length ? lines : ["Расходов пока нет."]),
        ...(total ? [total.trimStart()] : []),
      ].join("\n"), keyboard);
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendParticipantSummary(ctx: BotContext, todayOnly: boolean): Promise<void> {
    try {
      const moneyNotice = await syncManualMoneyNotice(ctx);
      const [summary, connection] = await Promise.all([
        service.getParticipantSummary(chatId(ctx), todayOnly),
        service.getConnection(chatId(ctx)),
      ]);
      const lines = summary.lines.map((line) =>
        `${line.participant}: ${formatMoney(line.amountBase, summary.baseCurrency)} · ${line.count} оп.`,
      );
      const total = summary.lines.reduce((sum, line) => sum + line.amountBase, 0);
      await showScreen(
        ctx,
        [
          ...(moneyNotice ? [moneyNotice, ""] : []),
          `Участники · ${todayOnly ? `сегодня, ${formatDate(summary.date ?? "")}` : "вся поездка"}`,
          connection?.title ?? "Поездка",
          "",
          ...(lines.length ? lines : ["Расходов пока нет."]),
          ...(lines.length ? ["", `Всего: ${formatMoney(total, summary.baseCurrency)}`] : []),
        ].join("\n"),
        new InlineKeyboard()
          .text(todayOnly ? "✓ Сегодня" : "Сегодня", "participants:today")
          .text(todayOnly ? "Вся поездка" : "✓ Вся поездка", "participants:all")
          .row()
          .text("← К категориям", todayOnly ? "summary:today" : "summary:all"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  function recentTransactionLabel(transaction: StoredTransaction): string {
    const marker = transaction.type === "expense"
      ? "−"
      : transaction.type === "transfer_out"
        ? "⇄"
        : "+";
    const name = compactTitle(transaction.description || transaction.category);
    return `${formatDate(transaction.date)} · ${marker}${formatMoney(transaction.purchaseAmount, transaction.purchaseCurrency)} · ${name}`;
  }

  async function sendRecentTransactions(ctx: BotContext, notice = ""): Promise<void> {
    try {
      notice = combineNotices(notice, await syncManualMoneyNotice(ctx));
      const transactions = await service.getRecentTransactions(chatId(ctx), 10);
      const keyboard = new InlineKeyboard();
      for (const transaction of transactions) {
        keyboard.text(recentTransactionLabel(transaction), `history:view:${transaction.id}`).row();
      }
      keyboard.text("⌂ Главная", "menu:home");
      await showScreen(
        ctx,
        [
          ...(notice ? [notice, ""] : []),
          "Последние операции",
          "",
          transactions.length
            ? "Выбери операцию, чтобы исправить, повторить или отменить."
            : "Операций пока нет.",
        ].join("\n"),
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendFavorites(ctx: BotContext, notice = ""): Promise<void> {
    try {
      const favorites = await service.getFavorites(chatId(ctx));
      const keyboard = new InlineKeyboard();
      favorites.forEach((favorite) => {
        const marker = favorite.type === "expense" ? "−" : "+";
        keyboard
          .text(
            `${marker} ${compactTitle(favorite.name)} · ${formatMoney(favorite.purchaseAmount, favorite.purchaseCurrency)}`,
            `favorite:use:${favorite.id}`,
          )
          .text("×", `favorite:remove:${favorite.id}`)
          .row();
      });
      keyboard.text("⌂ Главная", "menu:home");
      await showScreen(
        ctx,
        [
          ...(notice ? [notice, ""] : []),
          "★ Быстрые операции",
          "",
          favorites.length
            ? "Нажми на шаблон — операция запишется сразу. × удаляет шаблон."
            : "Сохрани часто повторяемую операцию из экрана последних операций.",
        ].join("\n"),
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendTransactionDetail(
    ctx: BotContext,
    transactionId: string,
    notice = "",
  ): Promise<void> {
    try {
      const transaction = await service.getTransaction(chatId(ctx), transactionId);
      if (transaction.transferId) {
        const pair = await service.getTransferPair(chatId(ctx), transaction.transferId);
        const isExchange = pair.source.currency !== pair.destination.currency;
        await showScreen(
          ctx,
          [
            ...(notice ? [notice, ""] : []),
            `${isExchange ? "Обмен" : "Перевод"} · ${formatDate(pair.source.date)}`,
            pair.source.description,
            `− ${formatMoney(pair.source.amount, pair.source.currency)} · ${pair.source.accountName}`,
            `+ ${formatMoney(pair.destination.amount, pair.destination.currency)} · ${pair.destination.accountName}`,
            ...(isExchange
              ? [`Курс: 1 ${pair.source.currency} = ${formatRate(pair.destination.amount / pair.source.amount)} ${pair.destination.currency}`]
              : []),
          ].join("\n"),
          new InlineKeyboard()
            .text("↻ Повторить", `history:repeat:${pair.source.id}`)
            .text("✎ Исправить", `history:edit:${pair.source.id}`)
            .row()
            .text("× Отменить перевод", `history:delete:${pair.source.id}`)
            .row()
            .text("← К списку", "menu:recent"),
        );
        return;
      }
      const kind = transaction.type === "expense" ? "Расход" : "Пополнение";
      const syncLine = transaction.type === "expense"
        ? `Money: ${transaction.moneySyncStatus === "synced"
            ? "синхронизировано"
            : transaction.moneySyncStatus === "not_applicable"
              ? "не используется"
              : transaction.moneySyncStatus === "failed"
                ? "ожидает повтора после ошибки"
                : "ожидает синхронизации"}`
        : "";
      await showScreen(
        ctx,
        [
          ...(notice ? [notice, ""] : []),
          `${kind} · ${formatDate(transaction.date)}`,
          transaction.description || transaction.category,
          `${formatMoney(transaction.purchaseAmount, transaction.purchaseCurrency)} · ${transaction.category}`,
          `Счёт: ${transaction.accountName}`,
          ...(transaction.purchaseCurrency !== transaction.currency || transaction.purchaseAmount !== transaction.amount
            ? [`По счёту: ${formatMoney(transaction.amount, transaction.currency)}`]
            : []),
          ...(syncLine ? [syncLine] : []),
        ].join("\n"),
        new InlineKeyboard()
          .text("↻ Повторить", `history:repeat:${transaction.id}`)
          .text("✎ Исправить", `history:edit:${transaction.id}`)
          .row()
          .text("★ В избранное", `history:favorite:${transaction.id}`)
          .row()
          .text("× Отменить операцию", `history:delete:${transaction.id}`)
          .row()
          .text("← К списку", "menu:recent"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function showTransactionEditMenu(
    ctx: BotContext,
    transactionId: string,
  ): Promise<void> {
    ctx.session.flow = { kind: "idle" };
    const transaction = await service.getTransaction(chatId(ctx), transactionId);
    if (transaction.transferId) {
      await startTransfer(ctx, transaction.transferId);
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("Сумму", `history:edit:amount:${transaction.id}`)
      .text("Название", `history:edit:description:${transaction.id}`)
      .row();
    if (transaction.type === "expense") {
      keyboard.text("Категорию", `history:edit:category:${transaction.id}`);
    }
    keyboard.text("Счёт", `history:edit:account:${transaction.id}`)
      .row()
      .text("← Назад", `history:view:${transaction.id}`);
    await showScreen(ctx, "Что исправить в операции?", keyboard);
  }

  async function sendRates(ctx: BotContext, notice = ""): Promise<void> {
    try {
      const rates = await service.getRates(chatId(ctx));
      const value = (rate: number | null) => (rate ? formatRate(rate) : "не задан");
      const usdJpy = calculateUsdJpyRate(rates);
      await showScreen(
        ctx,
        [
          notice,
          "Курсы\nДля будущих операций",
          `1 USD = ${value(rates.usdRub)} RUB`,
          `1 JPY = ${value(rates.jpyRub)} RUB`,
          `1 USD = ${value(usdJpy)} JPY`,
          "",
          "Кросс-курс USD/JPY рассчитывается математически через RUB. Фактический курс операции — из цены и реального списания.",
          "Уже записанные расходы сохраняют прежний курс.",
        ].filter((line, index, all) => line || (index > 0 && index < all.length - 1)).join("\n"),
        new InlineKeyboard()
          .text("USD/RUB", "rate:set:USD")
          .row()
          .text("JPY/RUB", "rate:set:JPY")
          .row()
          .text("← Назад", "menu:settings"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendSettings(ctx: BotContext, notice = ""): Promise<void> {
    try {
      const [baseCurrency, homeTimezone, localTimezone] = await Promise.all([
        service.getBaseCurrency(chatId(ctx)),
        service.getHomeTimezone(chatId(ctx)),
        service.getLocalTimezone(chatId(ctx)),
      ]);
      await showScreen(
        ctx,
        [
          ...(notice ? [notice, ""] : []),
          "Настройки",
          `Базовая валюта поездки: ${baseCurrency}`,
          `Домашнее время: ${timezoneLabel(homeTimezone, HOME_TIMEZONES)} · ${formatTime(homeTimezone)}`,
          `На месте: ${timezoneLabel(localTimezone, LOCAL_TIMEZONES)} · ${formatTime(localTimezone)}`,
        ]
          .join("\n"),
        new InlineKeyboard()
          .text("Базовая валюта", "settings:base")
          .row()
          .text("Домашнее время", "settings:home")
          .row()
          .text("Время на месте", "settings:local")
          .row()
          .text("Курсы валют", "menu:rates")
          .row()
          .text("Бюджеты", "menu:budgets")
          .row()
          .text("Ежедневный digest", "menu:digest")
          .row()
          .text("⌂ Главная", "menu:home"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendBudgets(ctx: BotContext, notice = ""): Promise<void> {
    try {
      const [status, categories] = await Promise.all([
        service.getBudgetStatus(chatId(ctx)),
        service.getCategories(chatId(ctx)),
      ]);
      const progressLine = (label: string, spent: number, limit: number, percent: number) =>
        `${label}: ${formatMoney(spent, status.baseCurrency)} / ${formatMoney(limit, status.baseCurrency)} · ${Math.round(percent)}%`;
      const lines = [
        ...(notice ? [notice, ""] : []),
        "Бюджеты",
        `Все лимиты указаны в ${status.baseCurrency}.`,
        "",
        status.daily
          ? progressLine("Сегодня", status.daily.spent, status.daily.limit, status.daily.percent)
          : "Дневной лимит не задан.",
        ...status.categories.map((item) =>
          progressLine(item.category, item.spent, item.limit, item.percent)
        ),
      ];
      const keyboard = new InlineKeyboard().text("Лимит на день", "budget:daily").row();
      categories.forEach((category, index) => {
        keyboard.text(category, `budget:category:${index}`);
        if (index % 2 === 1) keyboard.row();
      });
      keyboard.row().text("← Назад", "menu:settings");
      await showScreen(ctx, lines.join("\n"), keyboard);
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendDigestSettings(ctx: BotContext, notice = ""): Promise<void> {
    try {
      const settings = await service.getDigestSettings(chatId(ctx));
      await showScreen(
        ctx,
        [
          ...(notice ? [notice, ""] : []),
          "Ежедневный digest",
          `Статус: ${settings.enabled ? "включён" : "выключен"}`,
          `Время: ${settings.time} · ${timezoneLabel(settings.timezone, LOCAL_TIMEZONES)}`,
          "",
          "Бот пришлёт расходы дня, остатки и состояние дневного бюджета.",
        ].join("\n"),
        new InlineKeyboard()
          .text(settings.enabled ? "Выключить" : "Включить", "digest:toggle")
          .row()
          .text("Изменить время", "digest:time")
          .row()
          .text("← Назад", "menu:settings"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function undo(ctx: BotContext): Promise<void> {
    try {
      const transaction = await service.undoLast(chatId(ctx));
      await sendMain(
        ctx,
        transaction
          ? `↶ Отменено: ${transaction.description || transaction.category} · ${formatMoney(transaction.amount, transaction.currency)}`
          : "Нет операций для отмены.",
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function goBack(ctx: BotContext): Promise<void> {
    const flow = ctx.session.flow;
    if (flow.kind === "connect_url") {
      ctx.session.flow = { kind: "idle" };
      await sendTrips(ctx);
      return;
    }
    if (flow.kind === "transaction_currency" || flow.kind === "transaction_income_amount") {
      ctx.session.flow = { kind: "idle" };
      await chooseAccount(ctx, flow.kind === "transaction_income_amount" ? "income" : "expense");
      return;
    }
    if (flow.kind === "transaction_purchase_amount") {
      ctx.session.flow = {
        kind: "transaction_currency",
        accountId: flow.accountId,
        accountName: flow.accountName,
        accountCurrency: flow.accountCurrency,
      };
      const baseCurrency = await service.getBaseCurrency(chatId(ctx));
      const keyboard = new InlineKeyboard();
      [...new Set([baseCurrency, flow.accountCurrency, "JPY", "USD", "RUB"])].forEach(
        (currency, index) => {
          keyboard.text(currency, `tx:currency:${currency}`);
          if (index % 3 === 2) keyboard.row();
        },
      );
      keyboard.row().text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel");
      await showScreen(ctx, `Новый расход · 2/4\n${flow.accountName} · ${flow.accountCurrency}\n\nВ какой валюте указана цена?`, keyboard);
      return;
    }
    if (flow.kind === "transaction_account_amount" || flow.kind === "transaction_category") {
      ctx.session.flow = {
        kind: "transaction_purchase_amount",
        accountId: flow.accountId,
        accountName: flow.accountName,
        accountCurrency: flow.accountCurrency,
        purchaseCurrency: flow.purchaseCurrency,
      };
      await showScreen(
        ctx,
        `Новый расход · 2/4\n${flow.accountName} · цена в ${flow.purchaseCurrency}\n\nОтправь сумму покупки.`,
        cancelKeyboard(),
      );
      return;
    }
    if (flow.kind === "transaction_description") {
      if (flow.type === "income") {
        const account = (await service.getAccounts(chatId(ctx))).find((item) => item.id === flow.accountId);
        if (!account) throw new UserFacingError("Счёт больше не найден.");
        ctx.session.flow = {
          kind: "transaction_income_amount",
          accountId: account.id,
          accountName: account.name,
          accountCurrency: account.currency,
        };
        await showScreen(ctx, `Пополнение · 1/2\n${account.name} · ${account.currency}\n\nОтправь сумму пополнения.`, cancelKeyboard());
        return;
      }
      const account = (await service.getAccounts(chatId(ctx))).find((item) => item.id === flow.accountId);
      if (!account) throw new UserFacingError("Счёт больше не найден.");
      await showCategories(ctx, {
        accountId: account.id,
        accountName: account.name,
        accountCurrency: account.currency,
        accountAmount: flow.accountAmount,
        purchaseAmount: flow.purchaseAmount,
        purchaseCurrency: flow.purchaseCurrency,
      });
      return;
    }
    if (flow.kind === "account_name") {
      await startAccountCreation(ctx);
      return;
    }
    if (flow.kind === "account_currency") {
      ctx.session.flow = { kind: "account_name", accountKind: flow.accountKind };
      await showScreen(ctx, "Новый счёт · 2/4\n\nОтправь короткое название.", cancelKeyboard());
      return;
    }
    if (flow.kind === "account_opening") {
      ctx.session.flow = { kind: "account_currency", accountKind: flow.accountKind, name: flow.name };
      await showScreen(
        ctx,
        `Новый счёт · 3/4\n${flow.name}\n\nВыбери валюту.`,
        new InlineKeyboard()
          .text("JPY", "account:currency:JPY").text("USD", "account:currency:USD").text("RUB", "account:currency:RUB")
          .row().text("Другая валюта", "account:currency:other")
          .row().text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel"),
      );
      return;
    }
    if (flow.kind === "account_rate") {
      ctx.session.flow = {
        kind: "account_opening",
        accountKind: flow.accountKind,
        name: flow.name,
        currency: flow.currency,
      };
      await showScreen(ctx, `Новый счёт · 4/4\n${flow.name} · ${flow.currency}\n\nОтправь начальный остаток. Можно 0.`, cancelKeyboard());
      return;
    }
    if (flow.kind === "transfer_destination") {
      await startTransfer(ctx, flow.replaceTransferId);
      return;
    }
    if (flow.kind === "transfer_source_amount") {
      const accounts = await service.getBalances(chatId(ctx));
      ctx.session.flow = {
        kind: "transfer_destination",
        sourceAccountId: flow.sourceAccountId,
        replaceTransferId: flow.replaceTransferId,
      };
      const keyboard = new InlineKeyboard();
      accounts.filter((item) => item.id !== flow.sourceAccountId).forEach((item) => keyboard.text(`${item.name} · ${item.currency}`, `transfer:destination:${item.id}`).row());
      keyboard.text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel");
      await showScreen(ctx, `Новый перевод · 2/3\nСо счёта: ${flow.sourceAccountName}\n\nКуда зачислить?`, keyboard);
      return;
    }
    if (flow.kind === "transfer_destination_amount") {
      ctx.session.flow = { ...flow, kind: "transfer_source_amount" };
      await showScreen(ctx, `Новый перевод · 3/3\n${flow.sourceAccountName} → ${flow.destinationAccountName}\n\nСколько списано в ${flow.sourceCurrency}?`, cancelKeyboard());
      return;
    }
    if (flow.kind === "transfer_ready") {
      ctx.session.flow = {
        ...flow,
        kind: "transfer_source_amount",
      };
      await showScreen(ctx, `Новый перевод · 3/3\n${flow.sourceAccountName} → ${flow.destinationAccountName}\n\nСколько списано в ${flow.sourceCurrency}?`, cancelKeyboard());
      return;
    }
    if (flow.kind.startsWith("history_edit_")) {
      await showTransactionEditMenu(ctx, (flow as { transactionId: string }).transactionId);
      return;
    }
    if (flow.kind === "rate_value") {
      ctx.session.flow = { kind: "idle" };
      await sendRates(ctx);
      return;
    }
    if (flow.kind === "base_currency_code" || flow.kind === "base_currency_rate") {
      ctx.session.flow = { kind: "idle" };
      await showScreen(
        ctx,
        "Базовая валюта страны поездки:\n\nВыбери USD или EUR либо добавь свою валюту.",
        baseCurrencyKeyboard(),
      );
      return;
    }
    if (flow.kind === "local_timezone") {
      ctx.session.flow = { kind: "idle" };
      await sendSettings(ctx);
      return;
    }
    if (flow.kind === "budget_daily" || flow.kind === "budget_category_value") {
      ctx.session.flow = { kind: "idle" };
      await sendBudgets(ctx);
      return;
    }
    if (flow.kind === "digest_time") {
      ctx.session.flow = { kind: "idle" };
      await sendDigestSettings(ctx);
      return;
    }
    ctx.session.flow = { kind: "idle" };
    await sendMain(ctx);
  }

  async function chooseAccount(ctx: BotContext, type: DirectTransactionType): Promise<void> {
    try {
      ctx.session.flow = { kind: "idle" };
      const accounts = await service.getBalances(chatId(ctx));
      if (!accounts.length) {
        await showScreen(
          ctx,
          "Сначала добавь счёт.",
          new InlineKeyboard().text("＋ Добавить счёт", "account:add").row().text("⌂ Главная", "menu:home"),
        );
        return;
      }
      const keyboard = new InlineKeyboard();
      accounts.forEach((account, index) => {
        keyboard.text(
          `${account.name} · ${formatMoney(account.balance, account.currency)}`,
          `tx:account:${type}:${account.id}`,
        );
        if (index % 2 === 1) keyboard.row();
      });
      keyboard
        .row()
        .text("← Назад", "flow:back")
        .row()
        .text("× Отменить", "flow:cancel");
      await showScreen(
        ctx,
        type === "expense"
          ? "Новый расход · 1/4\n\nВыбери счёт для оплаты."
          : "Пополнение · 1/2\n\nВыбери счёт.",
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function startTransfer(
    ctx: BotContext,
    replaceTransferId?: string,
  ): Promise<void> {
    try {
      const accounts = await service.getBalances(chatId(ctx));
      if (accounts.length < 2) {
        await showScreen(
          ctx,
          "Для перевода нужны минимум два счёта.",
          new InlineKeyboard().text("＋ Добавить счёт", "account:add").row().text("⌂ Главная", "menu:home"),
        );
        return;
      }
      ctx.session.flow = { kind: "transfer_source", replaceTransferId };
      const keyboard = new InlineKeyboard();
      accounts.forEach((account, index) => {
        keyboard.text(
          `${account.name} · ${formatMoney(account.balance, account.currency)}`,
          `transfer:source:${account.id}`,
        );
        if (index % 2 === 1) keyboard.row();
      });
      keyboard
        .row()
        .text("← Назад", "flow:back")
        .row()
        .text("× Отменить", "flow:cancel");
      await showScreen(
        ctx,
        `${replaceTransferId ? "Исправление перевода" : "Новый перевод"} · 1/3\n\nВыбери счёт списания.`,
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function completeTransfer(
    ctx: BotContext,
    data: {
      sourceAccountId: string;
      sourceAccountName: string;
      sourceCurrency: string;
      destinationAccountId: string;
      destinationAccountName: string;
      destinationCurrency: string;
      sourceAmount: number;
      destinationAmount: number;
      replaceTransferId?: string;
      operationIds?: RecordOperationIds["transfer"];
    },
  ): Promise<void> {
    const readyFlow: Extract<Flow, { kind: "transfer_ready" }> = {
      ...data,
      kind: "transfer_ready",
      operationIds: data.operationIds ?? createTransferOperationIds(),
    };
    ctx.session.flow = readyFlow;
    try {
      const input = {
        operationIds: readyFlow.operationIds,
        chatId: chatId(ctx),
        sourceAccountId: data.sourceAccountId,
        destinationAccountId: data.destinationAccountId,
        sourceAmount: data.sourceAmount,
        destinationAmount: data.destinationAmount,
        description: "",
        telegramUser: telegramUser(ctx),
      };
      const transfer = data.replaceTransferId
        ? await service.replaceTransfer(data.replaceTransferId, input)
        : await service.recordTransfer(input);
      ctx.session.flow = { kind: "idle" };
      await showRecordedTransfer(
        ctx,
        transfer,
        data.replaceTransferId ? "✓ Перевод исправлен" : "✓ Перевод записан",
      );
    } catch (error) {
      if (error instanceof UserFacingError) {
        await showScreen(ctx, error.message, cancelKeyboard());
        return;
      }
      console.error("Не удалось подтвердить запись перевода:", error);
      await showScreen(
        ctx,
        "Не удалось подтвердить запись в Google Sheets. Операция могла сохраниться — повтор использует тот же ID и не создаст дубль.",
        new InlineKeyboard()
          .text("↻ Проверить и повторить", "transfer:retry")
          .row()
          .text("× Отменить", "flow:cancel"),
      );
    }
  }

  async function showRecordedTransfer(
    ctx: BotContext,
    transfer: RecordedTransfer,
    notice: string,
  ): Promise<void> {
    const isExchange = transfer.source.currency !== transfer.destination.currency;
    const rate = transfer.destination.amount / transfer.source.amount;
    await showScreen(
      ctx,
      [
        notice,
        "",
        `− ${formatMoney(transfer.source.amount, transfer.source.currency)} · ${transfer.source.accountName}`,
        `+ ${formatMoney(transfer.destination.amount, transfer.destination.currency)} · ${transfer.destination.accountName}`,
        ...(isExchange
          ? [`Курс операции: 1 ${transfer.source.currency} = ${formatRate(rate)} ${transfer.destination.currency}`]
          : []),
      ].join("\n"),
      mainMenu(),
    );
  }

  async function showCategories(
    ctx: BotContext,
    data: {
      accountId: string;
      accountName: string;
      accountCurrency: string;
      accountAmount: number;
      purchaseAmount: number;
      purchaseCurrency: string;
    },
  ): Promise<void> {
    const categories = await service.getCategories(chatId(ctx));
    const keyboard = new InlineKeyboard();
    categories.forEach((category, index) => {
      keyboard.text(category, `tx:category:${index}`);
      if (index % 2 === 1) keyboard.row();
    });
    keyboard
      .row()
      .text("← Назад", "flow:back")
      .row()
      .text("× Отменить", "flow:cancel");
    ctx.session.flow = {
      kind: "transaction_category",
      accountId: data.accountId,
      accountName: data.accountName,
      accountCurrency: data.accountCurrency,
      accountAmount: data.accountAmount,
      purchaseAmount: data.purchaseAmount,
      purchaseCurrency: data.purchaseCurrency,
      categories,
    };
    await showScreen(
      ctx,
      [
        "Новый расход · 3/4",
        `${formatMoney(data.purchaseAmount, data.purchaseCurrency)} · ${data.accountName}`,
        "",
        "Выбери категорию.",
      ].join("\n"),
      keyboard,
    );
  }

  async function completeTransaction(ctx: BotContext, description: string): Promise<void> {
    const flow = ctx.session.flow;
    if (flow.kind !== "transaction_description") return;
    const transactionId = flow.transactionId ?? createTransactionId();
    ctx.session.flow = { ...flow, transactionId, description };
    try {
      const transaction = await service.recordTransaction({
        transactionId,
        chatId: chatId(ctx),
        type: flow.type,
        accountId: flow.accountId,
        accountAmount: flow.accountAmount,
        purchaseAmount: flow.purchaseAmount,
        purchaseCurrency: flow.purchaseCurrency,
        category: flow.category,
        description,
        telegramUser: telegramUser(ctx),
      });
      ctx.session.flow = { kind: "idle" };
      await showRecordedTransaction(ctx, transaction);
    } catch (error) {
      if (error instanceof UserFacingError) {
        await showScreen(ctx, error.message, cancelKeyboard());
        return;
      }
      console.error("Не удалось подтвердить запись операции:", error);
      await showScreen(
        ctx,
        "Не удалось подтвердить запись в Google Sheets. Операция могла сохраниться — повтор использует тот же ID и не создаст дубль.",
        new InlineKeyboard()
          .text("↻ Проверить и повторить", "tx:retry")
          .row()
          .text("× Отменить", "flow:cancel"),
      );
    }
  }

  async function showRecordedTransaction(
    ctx: BotContext,
    transaction: TravelTransaction,
  ): Promise<void> {
      const action = transaction.type === "expense" ? "✓ Расход записан" : "✓ Счёт пополнен";
      const debitDiffers =
        transaction.purchaseCurrency !== transaction.currency ||
        Math.abs(transaction.purchaseAmount - transaction.amount) > 0.000001;
      const lines = transaction.type === "expense"
        ? [
            action,
            "",
            transaction.description || transaction.category,
            `${formatMoney(transaction.purchaseAmount, transaction.purchaseCurrency)} · ${transaction.category}`,
            transaction.accountName,
          ]
        : [
            action,
            "",
            formatMoney(transaction.purchaseAmount, transaction.purchaseCurrency),
            ...(transaction.description ? [transaction.description] : []),
            transaction.accountName,
          ];
      if (debitDiffers) lines.push(`Списано ${formatMoney(transaction.amount, transaction.currency)}`);
      const isUsdJpyExchange =
        new Set([transaction.purchaseCurrency, transaction.currency]).size === 2 &&
        [transaction.purchaseCurrency, transaction.currency].every((currency) =>
          ["USD", "JPY"].includes(currency),
        );
      if (isUsdJpyExchange && transaction.usdJpyRate) {
        lines.push(`Курс операции: 1 USD = ${formatRate(transaction.usdJpyRate)} JPY`);
      }
      if (transaction.purchaseCurrency !== "RUB") {
        lines.push(`≈ ${formatMoney(transaction.amountRub ?? 0, "RUB")}`);
        if (transaction.purchaseCurrency !== "USD" && transaction.amountUsd !== null) {
          lines.push(`≈ ${formatMoney(transaction.amountUsd, "USD")}`);
        }
      }
      if (transaction.moneySyncStatus === "failed") {
        lines.push("⚠ Money временно не обновлён — бот повторит синхронизацию автоматически.");
      }
      if (transaction.type === "expense") {
        try {
          lines.push(...await service.getBudgetWarnings(chatId(ctx), transaction.category));
        } catch (error) {
          console.error("Не удалось проверить бюджет после записи:", error);
        }
      }
      await showScreen(ctx, lines.join("\n"), mainMenu());
  }

  async function processNaturalText(
    ctx: BotContext,
    text: string,
    commandOverride?: NaturalCommand,
    forcedAccountId?: string,
    operationIdsOverride?: RecordOperationIds,
  ): Promise<void> {
    if (!naturalInput.enabled) {
      await sendMain(ctx, "Естественный ввод пока не настроен. Добавь OPENAI_API_KEY или используй кнопки.");
      return;
    }
    let retryCommand = commandOverride;
    const operationIds = operationIdsOverride ?? operationIdsForUpdate(ctx);
    try {
      const [connection, accounts, categories, baseCurrency] = await Promise.all([
        service.getConnection(chatId(ctx)),
        service.getBalances(chatId(ctx)),
        service.getCategories(chatId(ctx)),
        service.getBaseCurrency(chatId(ctx)),
      ]);
      if (!connection) throw new UserFacingError("Сначала подключи таблицу поездки.");
      const command = commandOverride ?? await naturalInput.interpret(text, {
        tripName: connection.title,
        baseCurrency,
        accounts: accounts.map((account) => ({ name: account.name, currency: account.currency })),
        categories,
      });
      retryCommand = command;
      ctx.session.flow = { kind: "idle" };

      if (command.intent === "balance") {
        await sendAccounts(ctx, text ? `Понял: «${text}»` : "Остатки по счетам");
        return;
      }
      if (command.intent === "summary") {
        await sendSummary(ctx, command.period !== "trip");
        return;
      }
      if (command.intent === "transfer") {
        if (command.amount === null) {
          await sendMain(ctx, "Не увидел сумму списания для перевода.");
          return;
        }
        const source = findNamedItem(accounts, command.accountName);
        const destination = findNamedItem(accounts, command.destinationAccountName);
        if (!source || !destination || source.id === destination.id) {
          await startTransfer(ctx);
          return;
        }
        if (command.currency && command.currency !== source.currency) {
          await sendMain(ctx, `Счёт «${source.name}» ведётся в ${source.currency}. Назови списание в этой валюте.`);
          return;
        }
        if (command.destinationCurrency && command.destinationCurrency !== destination.currency) {
          await sendMain(ctx, `Счёт «${destination.name}» ведётся в ${destination.currency}. Назови зачисление в этой валюте.`);
          return;
        }
        const destinationAmount = command.destinationAmount ?? (
          source.currency === destination.currency ? command.amount : null
        );
        if (destinationAmount === null) {
          await sendMain(ctx, "Для обмена назови обе суммы: сколько списано и сколько зачислено.");
          return;
        }
        const transfer = await service.recordTransfer({
          operationIds: operationIds.transfer,
          chatId: chatId(ctx),
          sourceAccountId: source.id,
          destinationAccountId: destination.id,
          sourceAmount: command.amount,
          destinationAmount,
          description: command.description ?? "",
          telegramUser: telegramUser(ctx),
        });
        await showRecordedTransfer(ctx, transfer, "✓ Перевод записан");
        return;
      }
      if (command.intent === "unknown") {
        await sendMain(ctx, `Не понял действие в сообщении «${text}». Пример: «Кофе 650 JPY наличными».`);
        return;
      }
      if (command.amount === null) {
        await sendMain(ctx, "Не увидел сумму. Отправь команду целиком, например: «Такси 1800 JPY с карты».");
        return;
      }

      const account = resolveNaturalAccount(accounts, command, forcedAccountId);
      if (!account) {
        ctx.session.flow = { kind: "natural_account", command };
        const keyboard = new InlineKeyboard();
        accounts.forEach((candidate, index) => {
          keyboard.text(candidate.name, `natural:account:${candidate.id}`);
          if (index % 2 === 1) keyboard.row();
        });
        keyboard.row().text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel");
        await showScreen(ctx, "Уточни счёт для операции.", keyboard);
        return;
      }

      if (command.intent === "income") {
        if (command.currency && command.currency !== account.currency) {
          await showScreen(
            ctx,
            `Счёт «${account.name}» ведётся в ${account.currency}, а названа сумма в ${command.currency}. Укажи сумму, которая фактически поступила в ${account.currency}.`,
            backKeyboard(),
          );
          return;
        }
        const transaction = await service.recordTransaction({
          transactionId: operationIds.transactionId,
          chatId: chatId(ctx),
          type: "income",
          accountId: account.id,
          accountAmount: command.amount,
          purchaseAmount: command.amount,
          purchaseCurrency: account.currency,
          category: "Пополнение",
          description: command.description?.trim() ?? "",
          telegramUser: telegramUser(ctx),
        });
        await showRecordedTransaction(ctx, transaction);
        return;
      }

      const purchaseCurrency = command.currency ?? baseCurrency;
      const category = findCategory(categories, command.category);
      if (!category) throw new UserFacingError("В поездке нет доступных категорий расходов.");
      const accountAmount = command.accountAmount ?? (
        purchaseCurrency === account.currency
          ? command.amount
          : await service.estimateAccountAmount(
              chatId(ctx),
              account.id,
              command.amount,
              purchaseCurrency,
            )
      );
      const transaction = await service.recordTransaction({
        transactionId: operationIds.transactionId,
        chatId: chatId(ctx),
        type: "expense",
        accountId: account.id,
        accountAmount,
        purchaseAmount: command.amount,
        purchaseCurrency,
        category,
        description: command.description?.trim() || category,
        telegramUser: telegramUser(ctx),
      });
      await showRecordedTransaction(ctx, transaction);
    } catch (error) {
      if (error instanceof UserFacingError) {
        ctx.session.flow = { kind: "idle" };
        await showScreen(ctx, error.message, backKeyboard());
        return;
      }
      console.error("Ошибка естественного ввода:", error);
      if (retryCommand) {
        ctx.session.flow = {
          kind: "natural_retry",
          command: retryCommand,
          forcedAccountId,
          operationIds,
        };
        await showScreen(
          ctx,
          "Не удалось подтвердить запись в Google Sheets. Операция могла сохраниться — повтор использует тот же ID и не создаст дубль.",
          new InlineKeyboard()
            .text("↻ Проверить и повторить", "natural:retry")
            .row()
            .text("× Отменить", "flow:cancel"),
        );
        return;
      }
      ctx.session.flow = { kind: "idle" };
      await showScreen(
        ctx,
        "Не удалось разобрать сообщение. Данные не записаны — попробуй ещё раз или используй кнопки.",
        mainMenu(),
      );
    }
  }

  function resolveNaturalAccount(
    accounts: AccountBalance[],
    command: NaturalCommand,
    forcedAccountId?: string,
  ): AccountBalance | null {
    if (forcedAccountId) {
      return accounts.find((account) => account.id === forcedAccountId) ?? null;
    }
    const named = findNamedItem(accounts, command.accountName);
    if (named) return named;
    const currency = command.intent === "income" ? command.currency : null;
    if (currency) {
      const sameCurrency = accounts.filter((account) => account.currency === currency);
      if (sameCurrency.length === 1) return sameCurrency[0] ?? null;
    }
    return accounts.length === 1 ? accounts[0] ?? null : null;
  }

  async function performQuickRecord(
    ctx: BotContext,
    flow: Extract<Flow, { kind: "quick_record_retry" }>,
  ): Promise<void> {
    ctx.session.flow = flow;
    try {
      const transaction = flow.action === "repeat"
        ? await service.repeatTransaction(
            chatId(ctx),
            flow.referenceId,
            telegramUser(ctx),
            flow.operationIds,
          )
        : await service.useFavorite(
            chatId(ctx),
            flow.referenceId,
            telegramUser(ctx),
            flow.operationIds.transactionId,
          );
      ctx.session.flow = { kind: "idle" };
      if (transaction.transferId) {
        const pair = await service.getTransferPair(chatId(ctx), transaction.transferId);
        await showRecordedTransfer(ctx, pair, "✓ Перевод повторён");
      } else {
        await showRecordedTransaction(ctx, transaction);
      }
    } catch (error) {
      if (error instanceof UserFacingError) {
        await replyError(ctx, error);
        return;
      }
      console.error("Не удалось подтвердить быструю операцию:", error);
      await showScreen(
        ctx,
        "Не удалось подтвердить запись в Google Sheets. Операция могла сохраниться — повтор использует тот же ID и не создаст дубль.",
        new InlineKeyboard()
          .text("↻ Проверить и повторить", "record:retry")
          .row()
          .text("× Отменить", "flow:cancel"),
      );
    }
  }

  async function sendSystemStatus(ctx: BotContext): Promise<void> {
    try {
      const status = await service.getSystemStatus(chatId(ctx));
      const queueState = status.failedMoneySync
        ? `⚠ Ошибок Money: ${status.failedMoneySync}`
        : status.pendingMoneySync
          ? `Ожидают Money: ${status.pendingMoneySync}`
          : "✓ Очередь Money пуста";
      const lastSync = status.lastMoneySyncedAt
        ? new Intl.DateTimeFormat("ru-RU", {
            dateStyle: "short",
            timeStyle: "medium",
          }).format(new Date(status.lastMoneySyncedAt))
        : "ещё не было";
      await showScreen(
        ctx,
        [
          "Диагностика",
          `✈ ${status.connectionTitle}`,
          "✓ Google Sheets отвечает",
          queueState,
          `Счетов: ${status.accounts}`,
          `Активных записей: ${status.activeTransactions}`,
          `Последняя синхронизация Money: ${lastSync}`,
          `Ответ: ${status.responseTimeMs} мс`,
        ].join("\n"),
        backKeyboard(),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  bot.command("start", (ctx) => sendMain(ctx));
  bot.command("help", (ctx) =>
    showScreen(
      ctx,
      "Как пользоваться\n\n" +
        "Все действия находятся на кнопках панели. Команды, названия и комментарии остаются в истории, а технический ввод вроде отдельной суммы бот аккуратно убирает.\n\n" +
        "Команды можно использовать как быстрые клавиши.",
      backKeyboard(),
    ),
  );
  bot.command("connect", async (ctx) => {
    const input = ctx.match.trim();
    if (input) await connectSpreadsheet(ctx, input);
    else await startConnect(ctx);
  });
  bot.command("trips", sendTrips);
  bot.command("current", sendTrips);
  bot.command("disconnect", sendTrips);
  bot.command("account", startAccountCreation);
  bot.command("accounts", (ctx) => sendAccounts(ctx));
  bot.command("expense", (ctx) => chooseAccount(ctx, "expense"));
  bot.command("income", (ctx) => chooseAccount(ctx, "income"));
  bot.command("summary", (ctx) => sendSummary(ctx, false));
  bot.command("participants", (ctx) => sendParticipantSummary(ctx, false));
  bot.command("recent", (ctx) => sendRecentTransactions(ctx));
  bot.command("transfer", (ctx) => startTransfer(ctx));
  bot.command("today", (ctx) => sendSummary(ctx, true));
  bot.command("rates", (ctx) => sendRates(ctx));
  bot.command("status", (ctx) => sendSystemStatus(ctx));
  bot.command("undo", undo);
  bot.command("cancel", async (ctx) => {
    ctx.session.flow = { kind: "idle" };
    await sendMain(ctx, "Ввод отменён.");
  });
  bot.command("skip", (ctx) => completeTransaction(ctx, ""));

  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.flow = { kind: "idle" };
    await sendMain(ctx);
  });
  bot.callbackQuery("flow:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    const message = ctx.callbackQuery.message;
    if (
      !isPersistedFlow(ctx.session.flow) ||
      !message ||
      !("text" in message) ||
      typeof message.text !== "string" ||
      !message.reply_markup
    ) {
      await sendMain(ctx);
      return;
    }
    ctx.session.flow = pauseFlow(ctx.session.flow, {
      text: message.text,
      inlineKeyboard: message.reply_markup.inline_keyboard,
    });
    await sendMain(ctx, "Черновик сохранён.");
  });
  bot.callbackQuery("flow:resume", async (ctx) => {
    await ctx.answerCallbackQuery();
    const pausedScreen = getPausedScreen(ctx.session.flow);
    if (!pausedScreen) {
      await sendMain(ctx, "Черновик уже завершён или сброшен.");
      return;
    }
    ctx.session.flow = resumeFlow(ctx.session.flow);
    await showScreen(
      ctx,
      pausedScreen.text,
      InlineKeyboard.from(pausedScreen.inlineKeyboard),
    );
  });
  bot.callbackQuery("menu:expense", async (ctx) => {
    await ctx.answerCallbackQuery();
    await chooseAccount(ctx, "expense");
  });
  bot.callbackQuery("menu:income", async (ctx) => {
    await ctx.answerCallbackQuery();
    await chooseAccount(ctx, "income");
  });
  bot.callbackQuery("menu:accounts", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendAccounts(ctx);
  });
  bot.callbackQuery("menu:summary", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSummary(ctx, false);
  });
  bot.callbackQuery("menu:recent", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendRecentTransactions(ctx);
  });
  bot.callbackQuery("menu:transfer", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startTransfer(ctx);
  });
  bot.callbackQuery("menu:favorites", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendFavorites(ctx);
  });
  bot.callbackQuery("summary:today", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSummary(ctx, true);
  });
  bot.callbackQuery("summary:all", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSummary(ctx, false);
  });
  bot.callbackQuery(/^participants:(today|all)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendParticipantSummary(ctx, ctx.match[1] === "today");
  });
  bot.callbackQuery("menu:trips", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendTrips(ctx);
  });
  bot.callbackQuery("menu:settings", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSettings(ctx);
  });
  bot.callbackQuery("menu:rates", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendRates(ctx);
  });
  bot.callbackQuery("menu:budgets", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendBudgets(ctx);
  });
  bot.callbackQuery("menu:digest", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendDigestSettings(ctx);
  });
  bot.callbackQuery("digest:toggle", async (ctx) => {
    await ctx.answerCallbackQuery();
    const current = await service.getDigestSettings(chatId(ctx));
    await service.setDigestEnabled(chatId(ctx), !current.enabled);
    await sendDigestSettings(ctx, !current.enabled ? "✓ Digest включён." : "Digest выключен.");
  });
  bot.callbackQuery("digest:time", async (ctx) => {
    await ctx.answerCallbackQuery();
    const current = await service.getDigestSettings(chatId(ctx));
    ctx.session.flow = { kind: "digest_time" };
    await showScreen(
      ctx,
      `Сейчас: ${current.time}\n\nОтправь новое время в формате ЧЧ:ММ. Оно считается по часовому поясу поездки ${current.timezone}.`,
      cancelKeyboard(),
    );
  });
  bot.callbackQuery("budget:daily", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.flow = { kind: "budget_daily" };
    const status = await service.getBudgetStatus(chatId(ctx));
    await showScreen(
      ctx,
      `Дневной бюджет в ${status.baseCurrency}\n\nОтправь лимит или 0, чтобы отключить.`,
      cancelKeyboard(),
    );
  });
  bot.callbackQuery(/^budget:category:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const categories = await service.getCategories(chatId(ctx));
    const category = categories[Number(ctx.match[1])];
    if (!category) return;
    ctx.session.flow = { kind: "budget_category_value", category };
    const status = await service.getBudgetStatus(chatId(ctx));
    await showScreen(
      ctx,
      `Бюджет «${category}» на всю поездку в ${status.baseCurrency}\n\nОтправь лимит или 0, чтобы отключить.`,
      cancelKeyboard(),
    );
  });
  bot.callbackQuery("menu:undo", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showScreen(
      ctx,
      "Отменить последнюю операцию?\n\nРасход также исчезнет из Money, а баланс будет пересчитан.",
      new InlineKeyboard()
        .text("↶ Да, отменить", "undo:confirm")
        .row()
        .text("⌂ Главная", "menu:home"),
    );
  });
  bot.callbackQuery("undo:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    await undo(ctx);
  });
  bot.callbackQuery("flow:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.flow = { kind: "idle" };
    await sendMain(ctx);
  });
  bot.callbackQuery("flow:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await goBack(ctx);
    } catch (error) {
      await replyError(ctx, error);
    }
  });

  bot.callbackQuery("tx:skip", async (ctx) => {
    await ctx.answerCallbackQuery();
    await completeTransaction(ctx, "");
  });
  bot.callbackQuery("tx:retry", async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transaction_description") return;
    await completeTransaction(ctx, flow.description ?? "");
  });
  bot.callbackQuery("transfer:retry", async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transfer_ready") return;
    await completeTransfer(ctx, flow);
  });

  bot.callbackQuery(/^natural:account:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "natural_account") return;
    await processNaturalText(ctx, "", flow.command, ctx.match[1]);
  });
  bot.callbackQuery("natural:retry", async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "natural_retry") return;
    await processNaturalText(
      ctx,
      "",
      flow.command,
      flow.forcedAccountId,
      flow.operationIds,
    );
  });
  bot.callbackQuery("record:retry", async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "quick_record_retry") return;
    await performQuickRecord(ctx, flow);
  });

  bot.callbackQuery(/^history:view:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendTransactionDetail(ctx, ctx.match[1]);
  });
  bot.callbackQuery(/^history:repeat:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await performQuickRecord(ctx, {
      kind: "quick_record_retry",
      action: "repeat",
      referenceId: ctx.match[1],
      operationIds: operationIdsForUpdate(ctx),
    });
  });
  bot.callbackQuery(/^history:favorite:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const favorite = await service.saveFavorite(chatId(ctx), ctx.match[1]);
      await sendTransactionDetail(ctx, ctx.match[1], `★ «${favorite.name}» добавлено в быстрые операции.`);
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^favorite:use:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await performQuickRecord(ctx, {
      kind: "quick_record_retry",
      action: "favorite",
      referenceId: ctx.match[1],
      operationIds: operationIdsForUpdate(ctx),
    });
  });
  bot.callbackQuery(/^favorite:remove:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await service.removeFavorite(chatId(ctx), ctx.match[1]);
      await sendFavorites(ctx, "Шаблон удалён.");
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^history:edit:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await showTransactionEditMenu(ctx, ctx.match[1]);
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^history:delete:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const transaction = await service.getTransaction(chatId(ctx), ctx.match[1]);
    await showScreen(
      ctx,
      `Отменить операцию «${transaction.description || transaction.category}» на ${formatMoney(transaction.purchaseAmount, transaction.purchaseCurrency)}?`,
      new InlineKeyboard()
        .text("Да, отменить", `history:delete:confirm:${transaction.id}`)
        .row()
        .text("← Назад", `history:view:${transaction.id}`),
    );
  });
  bot.callbackQuery(/^history:delete:confirm:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const transaction = await service.undoTransaction(chatId(ctx), ctx.match[1]);
      await sendRecentTransactions(
        ctx,
        `↶ Отменено: ${transaction.description || transaction.category} · ${formatMoney(transaction.purchaseAmount, transaction.purchaseCurrency)}`,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^history:edit:amount:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const transaction = await service.getTransaction(chatId(ctx), ctx.match[1]);
    ctx.session.flow = {
      kind: "history_edit_amount",
      transactionId: transaction.id,
      replacementTransactionId: createTransactionId(),
    };
    await showScreen(
      ctx,
      `Текущая сумма: ${formatMoney(transaction.purchaseAmount, transaction.purchaseCurrency)}\n\nОтправь новую сумму.`,
      cancelKeyboard(),
    );
  });
  bot.callbackQuery(/^history:edit:description:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const transaction = await service.getTransaction(chatId(ctx), ctx.match[1]);
    ctx.session.flow = {
      kind: "history_edit_description",
      transactionId: transaction.id,
      replacementTransactionId: createTransactionId(),
    };
    await showScreen(
      ctx,
      `Текущее название: ${transaction.description || transaction.category}\n\nОтправь новое название.`,
      cancelKeyboard(),
    );
  });
  bot.callbackQuery(/^history:edit:category:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [transaction, categories] = await Promise.all([
      service.getTransaction(chatId(ctx), ctx.match[1]),
      service.getCategories(chatId(ctx)),
    ]);
    ctx.session.flow = {
      kind: "history_edit_category",
      transactionId: transaction.id,
      replacementTransactionId: createTransactionId(),
      categories,
    };
    const keyboard = new InlineKeyboard();
    categories.forEach((category, index) => {
      keyboard.text(category, `history:category:${index}`);
      if (index % 2 === 1) keyboard.row();
    });
    keyboard.row().text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel");
    await showScreen(ctx, `Текущая категория: ${transaction.category}\n\nВыбери новую.`, keyboard);
  });
  bot.callbackQuery(/^history:category:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "history_edit_category") return;
    const category = flow.categories[Number(ctx.match[1])];
    if (!category) return;
    try {
      const replacement = await service.replaceTransaction(
        chatId(ctx),
        flow.transactionId,
        { category },
        telegramUser(ctx),
        flow.replacementTransactionId,
      );
      ctx.session.flow = { kind: "idle" };
      await sendTransactionDetail(ctx, replacement.id, "✓ Категория исправлена.");
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^history:edit:account:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [transaction, accounts] = await Promise.all([
      service.getTransaction(chatId(ctx), ctx.match[1]),
      service.getBalances(chatId(ctx)),
    ]);
    ctx.session.flow = {
      kind: "history_edit_account",
      transactionId: transaction.id,
      replacementTransactionId: createTransactionId(),
    };
    const keyboard = new InlineKeyboard();
    accounts.forEach((account, index) => {
      keyboard.text(account.name, `history:account:${account.id}`);
      if (index % 2 === 1) keyboard.row();
    });
    keyboard.row().text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel");
    await showScreen(ctx, `Текущий счёт: ${transaction.accountName}\n\nВыбери новый.`, keyboard);
  });
  bot.callbackQuery(/^history:account:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "history_edit_account") return;
    try {
      const [transaction, accounts] = await Promise.all([
        service.getTransaction(chatId(ctx), flow.transactionId),
        service.getAccounts(chatId(ctx)),
      ]);
      const account = accounts.find((candidate) => candidate.id === ctx.match[1]);
      if (!account) throw new UserFacingError("Счёт больше не найден.");
      const accountAmount = transaction.type === "income"
        ? transaction.purchaseAmount
        : transaction.purchaseCurrency === account.currency
          ? transaction.purchaseAmount
          : await service.estimateAccountAmount(
              chatId(ctx),
              account.id,
              transaction.purchaseAmount,
              transaction.purchaseCurrency,
            );
      const replacement = await service.replaceTransaction(
        chatId(ctx),
        transaction.id,
        {
          accountId: account.id,
          accountAmount,
          ...(transaction.type === "income" ? { purchaseCurrency: account.currency } : {}),
        },
        telegramUser(ctx),
        flow.replacementTransactionId,
      );
      ctx.session.flow = { kind: "idle" };
      await sendTransactionDetail(ctx, replacement.id, "✓ Счёт исправлен.");
    } catch (error) {
      await replyError(ctx, error);
    }
  });

  bot.callbackQuery("trip:connect", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startConnect(ctx);
  });
  bot.callbackQuery(/^trip:select:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const connection = await service.selectConnection(chatId(ctx), ctx.match[1]);
      ctx.session.flow = { kind: "idle" };
      await sendMain(ctx, `Выбрана поездка: ${connection.title}.`);
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^trip:remove:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const active = await service.getConnection(chatId(ctx));
      if (!active || active.spreadsheetId !== ctx.match[1]) {
        throw new UserFacingError("Активная поездка уже изменилась.");
      }
      const result = await service.disconnectCurrent(chatId(ctx));
      ctx.session.flow = { kind: "idle" };
      await showScreen(
        ctx,
        result.active
          ? `Отключено: ${result.removed?.title}.\nАктивна: ${result.active.title}.`
          : `Отключено: ${result.removed?.title}.`,
        result.active ? mainMenu() : new InlineKeyboard().text("Подключить таблицу", "trip:connect"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });

  bot.callbackQuery("account:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startAccountCreation(ctx);
  });
  bot.callbackQuery(/^account:kind:(card|cash|other)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.session.flow.kind !== "account_kind") return;
    ctx.session.flow = { kind: "account_name", accountKind: ctx.match[1] as AccountKind };
    await showScreen(
      ctx,
      "Новый счёт · 2/4\n\nОтправь короткое название.\nНапример: Карта CRY или Наличные JPY.",
      cancelKeyboard(),
    );
  });
  bot.callbackQuery(/^account:currency:([A-Z]{3})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "account_currency") return;
    ctx.session.flow = {
      kind: "account_opening",
      accountKind: flow.accountKind,
      name: flow.name,
      currency: ctx.match[1],
    };
    await showScreen(
      ctx,
      `Новый счёт · 4/4\n${flow.name} · ${ctx.match[1]}\n\nОтправь начальный остаток. Можно 0.`,
      cancelKeyboard(),
    );
  });

  bot.callbackQuery(/^transfer:source:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transfer_source") return;
    try {
      const [source, accounts] = await Promise.all([
        service.getAccounts(chatId(ctx)).then((items) =>
          items.find((account) => account.id === ctx.match[1])
        ),
        service.getBalances(chatId(ctx)),
      ]);
      if (!source) throw new UserFacingError("Счёт списания больше не найден.");
      ctx.session.flow = {
        kind: "transfer_destination",
        sourceAccountId: source.id,
        replaceTransferId: flow.replaceTransferId,
      };
      const keyboard = new InlineKeyboard();
      accounts.filter((account) => account.id !== source.id).forEach((account, index) => {
        keyboard.text(
          `${account.name} · ${account.currency}`,
          `transfer:destination:${account.id}`,
        );
        if (index % 2 === 1) keyboard.row();
      });
      keyboard.row().text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel");
      await showScreen(
        ctx,
        `Новый перевод · 2/3\nСо счёта: ${source.name}\n\nКуда зачислить?`,
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^transfer:destination:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transfer_destination") return;
    try {
      const accounts = await service.getAccounts(chatId(ctx));
      const source = accounts.find((account) => account.id === flow.sourceAccountId);
      const destination = accounts.find((account) => account.id === ctx.match[1]);
      if (!source || !destination) throw new UserFacingError("Один из счетов больше не найден.");
      ctx.session.flow = {
        kind: "transfer_source_amount",
        sourceAccountId: source.id,
        sourceAccountName: source.name,
        sourceCurrency: source.currency,
        destinationAccountId: destination.id,
        destinationAccountName: destination.name,
        destinationCurrency: destination.currency,
        replaceTransferId: flow.replaceTransferId,
        operationIds: createTransferOperationIds(),
      };
      await showScreen(
        ctx,
        [
          "Новый перевод · 3/3",
          `${source.name} → ${destination.name}`,
          "",
          `Сколько списано с «${source.name}» в ${source.currency}?`,
        ].join("\n"),
        cancelKeyboard(),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });

  bot.callbackQuery(/^tx:account:(expense|income):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const type = ctx.match[1] as DirectTransactionType;
      const account = (await service.getAccounts(chatId(ctx))).find(
        (candidate) => candidate.id === ctx.match[2],
      );
      if (!account) throw new UserFacingError("Счёт больше не найден.");
      if (type === "income") {
        ctx.session.flow = {
          kind: "transaction_income_amount",
          accountId: account.id,
          accountName: account.name,
          accountCurrency: account.currency,
        };
        await showScreen(
          ctx,
          `Пополнение · 1/2\n${account.name} · ${account.currency}\n\nОтправь сумму пополнения.`,
          cancelKeyboard(),
        );
        return;
      }
      const baseCurrency = await service.getBaseCurrency(chatId(ctx));
      ctx.session.flow = {
        kind: "transaction_currency",
        accountId: account.id,
        accountName: account.name,
        accountCurrency: account.currency,
      };
      const currencies = [...new Set([baseCurrency, account.currency, "JPY", "USD", "RUB"])];
      const keyboard = new InlineKeyboard();
      currencies.forEach((currency, index) => {
        keyboard.text(currency, `tx:currency:${currency}`);
        if (index % 3 === 2) keyboard.row();
      });
      keyboard.row().text("← Назад", "flow:back").row().text("× Отменить", "flow:cancel");
      await showScreen(
        ctx,
        `Новый расход · 2/4\n${account.name} · ${account.currency}\n\nВ какой валюте указана цена?`,
        keyboard,
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^tx:currency:([A-Z]{3})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transaction_currency") return;
    const purchaseCurrency = ctx.match[1];
    ctx.session.flow = { ...flow, kind: "transaction_purchase_amount", purchaseCurrency };
    await showScreen(
      ctx,
      `Новый расход · 2/4\n${flow.accountName} · цена в ${purchaseCurrency}\n\nОтправь сумму покупки.`,
      cancelKeyboard(),
    );
  });
  bot.callbackQuery("tx:auto", async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transaction_account_amount") return;
    try {
      const accountAmount = await service.estimateAccountAmount(
        chatId(ctx),
        flow.accountId,
        flow.purchaseAmount,
        flow.purchaseCurrency,
      );
      await showCategories(ctx, { ...flow, accountAmount });
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery("tx:manual", async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transaction_account_amount") return;
    await showScreen(
      ctx,
      [
        "Новый расход · 2/4",
        `${formatMoney(flow.purchaseAmount, flow.purchaseCurrency)} · ${flow.accountName}`,
        "",
        `Отправь фактическое списание в ${flow.accountCurrency}.`,
      ].join("\n"),
      cancelKeyboard(),
    );
  });
  bot.callbackQuery(/^tx:category:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "transaction_category") return;
    const category = flow.categories[Number(ctx.match[1])];
    if (!category) return;
    ctx.session.flow = {
      kind: "transaction_description",
      type: "expense",
      accountId: flow.accountId,
      accountAmount: flow.accountAmount,
      purchaseAmount: flow.purchaseAmount,
      purchaseCurrency: flow.purchaseCurrency,
      category,
      transactionId: createTransactionId(),
    };
    await showScreen(
      ctx,
      [
        "Новый расход · 4/4",
        `${formatMoney(flow.purchaseAmount, flow.purchaseCurrency)} · ${category}`,
        "",
        "Наименование в Money.\nНапример: Gran MS Kyoto или ужин в Итиран.",
      ].join("\n"),
      descriptionKeyboard(category),
    );
  });

  bot.callbackQuery("settings:base", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showScreen(
      ctx,
      "Базовая валюта страны поездки:\n\nВыбери USD или EUR либо добавь свою валюту.",
      baseCurrencyKeyboard(),
    );
  });
  bot.callbackQuery("settings:base:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.flow = { kind: "base_currency_code" };
    await showScreen(
      ctx,
      "Отправь код, название или символ валюты.\n\nНапример: GBP, дирхам, тенге или €.",
      cancelKeyboard(),
    );
  });
  bot.callbackQuery("settings:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const timezone = await service.getHomeTimezone(chatId(ctx));
      await showScreen(
        ctx,
        `Домашнее время\n\nСейчас: ${timezoneLabel(timezone, HOME_TIMEZONES)} · ${formatTime(timezone)}`,
        timezoneKeyboard(timezone, HOME_TIMEZONES, "settings:home", false),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery("settings:home:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    const timezone = await service.getHomeTimezone(chatId(ctx));
    await showScreen(
      ctx,
      "Для домашних часов теперь доступны Москва, Дубай и Токио.",
      timezoneKeyboard(timezone, HOME_TIMEZONES, "settings:home", false),
    );
  });
  bot.callbackQuery(/^settings:home:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const item = HOME_TIMEZONES[Number(ctx.match[1])];
    if (!item) return;
    try {
      await service.setHomeTimezone(chatId(ctx), item.timezone);
      ctx.session.flow = { kind: "idle" };
      await sendSettings(ctx, `✓ Домашнее время: ${item.label}`);
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery("settings:local", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const timezone = await service.getLocalTimezone(chatId(ctx));
      await showScreen(
        ctx,
        `Время на месте\n\nСейчас: ${timezoneLabel(timezone, LOCAL_TIMEZONES)} · ${formatTime(timezone)}`,
        timezoneKeyboard(timezone, LOCAL_TIMEZONES, "settings:local"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery("settings:local:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.flow = { kind: "local_timezone" };
    await showScreen(
      ctx,
      "Время на месте\n\nОтправь часовой пояс в формате Region/City.\nНапример: Europe/Paris или Asia/Almaty.",
      cancelKeyboard(),
    );
  });
  bot.callbackQuery(/^settings:local:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const item = LOCAL_TIMEZONES[Number(ctx.match[1])];
    if (!item) return;
    try {
      await service.setLocalTimezone(chatId(ctx), item.timezone);
      ctx.session.flow = { kind: "idle" };
      await sendSettings(ctx, `✓ Время на месте: ${item.label}`);
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^settings:base:(USD|EUR)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await selectBaseCurrency(ctx, ctx.match[1]);
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery(/^rate:set:(USD|JPY)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const currency = ctx.match[1] as "USD" | "JPY";
    ctx.session.flow = { kind: "rate_value", currency };
    await showScreen(ctx, `Сколько RUB сейчас стоит 1 ${currency}?`, cancelKeyboard());
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const flow = ctx.session.flow;
    try {
      if (flow.kind === "base_currency_code") {
        await selectBaseCurrency(ctx, text);
        return;
      }
      if (flow.kind === "base_currency_rate") {
        const rubRate = parseAmount(text);
        if (!rubRate) {
          await showScreen(
            ctx,
            `Не понял курс. Введи, сколько RUB стоит 1 ${flow.currency}. Например: 95,50.`,
            cancelKeyboard(),
          );
          return;
        }
        await service.setCurrencyRubRate(chatId(ctx), flow.currency, rubRate);
        await service.setBaseCurrency(chatId(ctx), flow.currency);
        ctx.session.flow = { kind: "idle" };
        await finishBaseCurrencySetup(
          ctx,
          `✓ Базовая валюта: ${flow.currency}.\n1 ${flow.currency} = ${formatRate(rubRate)} RUB.`,
        );
        return;
      }
      if (flow.kind === "digest_time") {
        const time = await service.setDigestTime(chatId(ctx), text);
        ctx.session.flow = { kind: "idle" };
        await sendDigestSettings(ctx, `✓ Время digest: ${time}.`);
        return;
      }
      if (flow.kind === "budget_daily" || flow.kind === "budget_category_value") {
        const limit = parseSignedAmount(text);
        if (limit === null || limit < 0) {
          await showScreen(ctx, "Не понял лимит. Введи положительное число или 0 для отключения.", cancelKeyboard());
          return;
        }
        if (flow.kind === "budget_daily") await service.setDailyBudget(chatId(ctx), limit);
        else await service.setCategoryBudget(chatId(ctx), flow.category, limit);
        ctx.session.flow = { kind: "idle" };
        await sendBudgets(ctx, limit > 0 ? "✓ Бюджет сохранён." : "Бюджет отключён.");
        return;
      }
      if (flow.kind === "transfer_source_amount") {
        const sourceAmount = parseAmount(text);
        if (!sourceAmount) {
          await showScreen(ctx, "Не понял сумму списания. Пример: 100 или 1 250,50.", cancelKeyboard());
          return;
        }
        if (flow.sourceCurrency === flow.destinationCurrency) {
          await completeTransfer(ctx, {
            ...flow,
            sourceAmount,
            destinationAmount: sourceAmount,
          });
          return;
        }
        ctx.session.flow = {
          ...flow,
          kind: "transfer_destination_amount",
          sourceAmount,
        };
        await showScreen(
          ctx,
          [
            "Обмен валюты · 3/3",
            `Списано ${formatMoney(sourceAmount, flow.sourceCurrency)} · ${flow.sourceAccountName}`,
            "",
            `Сколько фактически зачислено на «${flow.destinationAccountName}» в ${flow.destinationCurrency}?`,
          ].join("\n"),
          cancelKeyboard(),
        );
        return;
      }
      if (flow.kind === "transfer_destination_amount") {
        const destinationAmount = parseAmount(text);
        if (!destinationAmount) {
          await showScreen(ctx, "Не понял сумму зачисления. Пример: 15 500.", cancelKeyboard());
          return;
        }
        await completeTransfer(ctx, { ...flow, destinationAmount });
        return;
      }
      if (flow.kind === "connect_url") {
        await connectSpreadsheet(ctx, text);
        return;
      }
      if (flow.kind === "transaction_income_amount") {
        const accountAmount = parseAmount(text);
        if (!accountAmount) {
          await showScreen(ctx, "Не понял сумму. Пример: 1 250,50.", cancelKeyboard());
          return;
        }
        ctx.session.flow = {
          kind: "transaction_description",
          type: "income",
          accountId: flow.accountId,
          accountAmount,
          purchaseAmount: accountAmount,
          purchaseCurrency: flow.accountCurrency,
          category: "Пополнение",
          transactionId: createTransactionId(),
        };
        await showScreen(
          ctx,
          `Пополнение · 2/2\n${flow.accountName} · ${formatMoney(accountAmount, flow.accountCurrency)}\n\nДобавь комментарий или заверши без него.`,
          descriptionKeyboard(),
        );
        return;
      }
      if (flow.kind === "transaction_purchase_amount") {
        const purchaseAmount = parseAmount(text);
        if (!purchaseAmount) {
          await showScreen(ctx, "Не понял сумму. Пример: 1 250,50.", cancelKeyboard());
          return;
        }
        if (flow.purchaseCurrency === flow.accountCurrency) {
          await showCategories(ctx, {
            accountId: flow.accountId,
            accountName: flow.accountName,
            accountCurrency: flow.accountCurrency,
            accountAmount: purchaseAmount,
            purchaseAmount,
            purchaseCurrency: flow.purchaseCurrency,
          });
          return;
        }
        ctx.session.flow = { ...flow, kind: "transaction_account_amount", purchaseAmount };
        const estimatedAmount = await service.estimateAccountAmount(
          chatId(ctx),
          flow.accountId,
          purchaseAmount,
          flow.purchaseCurrency,
        );
        await showScreen(
          ctx,
          [
            "Новый расход · 2/4",
            `${formatMoney(purchaseAmount, flow.purchaseCurrency)} · ${flow.accountName}`,
            "",
            `Расчётное списание: ${formatMoney(estimatedAmount, flow.accountCurrency)}`,
          ].join("\n"),
          new InlineKeyboard()
            .text("✓ Использовать расчёт", "tx:auto")
            .row()
            .text("Ввести списание вручную", "tx:manual")
            .row()
            .text("← Назад", "flow:back")
            .row()
            .text("× Отменить", "flow:cancel"),
        );
        return;
      }
      if (flow.kind === "transaction_account_amount") {
        const accountAmount = parseAmount(text);
        if (!accountAmount) {
          await showScreen(ctx, "Не понял сумму списания. Пример: 515,10.", cancelKeyboard());
          return;
        }
        await showCategories(ctx, { ...flow, accountAmount });
        return;
      }
      if (flow.kind === "transaction_description") {
        await completeTransaction(ctx, text);
        return;
      }
      if (flow.kind === "history_edit_amount") {
        const purchaseAmount = parseAmount(text);
        if (!purchaseAmount) {
          await showScreen(ctx, "Не понял сумму. Пример: 1 250,50.", cancelKeyboard());
          return;
        }
        const original = await service.getTransaction(chatId(ctx), flow.transactionId);
        const accountAmount = original.type === "income"
          ? purchaseAmount
          : original.amount * (purchaseAmount / original.purchaseAmount);
        const replacement = await service.replaceTransaction(
          chatId(ctx),
          original.id,
          { purchaseAmount, accountAmount },
          telegramUser(ctx),
          flow.replacementTransactionId,
        );
        ctx.session.flow = { kind: "idle" };
        await sendTransactionDetail(ctx, replacement.id, "✓ Сумма исправлена.");
        return;
      }
      if (flow.kind === "history_edit_description") {
        if (text.length > 120) {
          await showScreen(ctx, "Название должно быть короче 120 символов.", cancelKeyboard());
          return;
        }
        const replacement = await service.replaceTransaction(
          chatId(ctx),
          flow.transactionId,
          { description: text },
          telegramUser(ctx),
          flow.replacementTransactionId,
        );
        ctx.session.flow = { kind: "idle" };
        await sendTransactionDetail(ctx, replacement.id, "✓ Название исправлено.");
        return;
      }
      if (flow.kind === "account_name") {
        if (text.length < 2 || text.length > 40) {
          await showScreen(ctx, "Название должно содержать от 2 до 40 символов.", cancelKeyboard());
          return;
        }
        ctx.session.flow = { kind: "account_currency", accountKind: flow.accountKind, name: text };
        await showScreen(
          ctx,
          `Новый счёт · 3/4\n${text}\n\nВыбери валюту.`,
          new InlineKeyboard()
            .text("JPY", "account:currency:JPY")
            .text("USD", "account:currency:USD")
            .text("RUB", "account:currency:RUB")
            .row()
            .text("Другая валюта", "account:currency:other")
            .row()
            .text("← Назад", "flow:back")
            .row()
            .text("× Отменить", "flow:cancel"),
        );
        return;
      }
      if (flow.kind === "account_currency") {
        const currency = normalizeCurrencyCode(text);
        if (!currency) {
          await showScreen(ctx, "Не узнаю валюту. Введи код, название или символ, например EUR, тенге или €.", cancelKeyboard());
          return;
        }
        ctx.session.flow = {
          kind: "account_opening",
          accountKind: flow.accountKind,
          name: flow.name,
          currency,
        };
        await showScreen(
          ctx,
          `Новый счёт · 4/4\n${flow.name} · ${currency}\n\nОтправь начальный остаток. Можно 0.`,
          cancelKeyboard(),
        );
        return;
      }
      if (flow.kind === "account_opening") {
        const openingBalance = parseSignedAmount(text);
        if (openingBalance === null) {
          await showScreen(ctx, "Не понял остаток. Введи число, 0 или отрицательное значение.", cancelKeyboard());
          return;
        }
        if (flow.currency !== "RUB") {
          const rubRate = await service.getCurrencyRubRate(chatId(ctx), flow.currency);
          if (rubRate) {
            const account = await service.addAccount(
              chatId(ctx), flow.accountKind, flow.name, flow.currency, openingBalance, rubRate,
            );
            ctx.session.flow = { kind: "idle" };
            await sendAccounts(ctx, `✓ Счёт создан: ${account.name}`);
            return;
          }
          ctx.session.flow = { ...flow, kind: "account_rate", openingBalance };
          await showScreen(
            ctx,
            `Новый счёт · курс\n${flow.name} · ${flow.currency}\n\nСколько RUB стоит 1 ${flow.currency}?`,
            cancelKeyboard(),
          );
          return;
        }
        const account = await service.addAccount(
          chatId(ctx), flow.accountKind, flow.name, flow.currency, openingBalance, 1,
        );
        ctx.session.flow = { kind: "idle" };
        await sendAccounts(ctx, `✓ Счёт создан: ${account.name}`);
        return;
      }
      if (flow.kind === "account_rate") {
        const rubRate = parseAmount(text);
        if (!rubRate) {
          await showScreen(ctx, "Не понял курс. Введи стоимость 1 единицы валюты в RUB.", cancelKeyboard());
          return;
        }
        const account = await service.addAccount(
          chatId(ctx), flow.accountKind, flow.name, flow.currency, flow.openingBalance, rubRate,
        );
        ctx.session.flow = { kind: "idle" };
        await sendAccounts(
          ctx,
          `✓ Счёт создан: ${account.name}\n1 ${account.currency} = ${formatRate(account.rubRate)} RUB`,
        );
        return;
      }
      if (flow.kind === "rate_value") {
        const rubRate = parseAmount(text);
        if (!rubRate) {
          await showScreen(ctx, "Не понял курс. Пример: 77,07 или 0,495856.", cancelKeyboard());
          return;
        }
        await service.setRate(chatId(ctx), flow.currency, rubRate);
        ctx.session.flow = { kind: "idle" };
        await sendRates(ctx, `Курс обновлён: 1 ${flow.currency} = ${formatRate(rubRate)} RUB.`);
        return;
      }
      if (flow.kind === "local_timezone") {
        const timezone = await service.setLocalTimezone(chatId(ctx), text);
        ctx.session.flow = { kind: "idle" };
        await sendSettings(
          ctx,
          `✓ Время на месте: ${timezoneLabel(timezone, LOCAL_TIMEZONES)} · ${formatTime(timezone)}`,
        );
        return;
      }
      if (flow.kind === "idle" && naturalInput.enabled) {
        await processNaturalText(ctx, text);
        return;
      }
      await sendMain(ctx);
    } catch (error) {
      await replyError(ctx, error);
    }
  });

  bot.on("message:voice", async (ctx) => {
    if (!naturalInput.enabled) {
      await showScreen(
        ctx,
        "Голосовой ввод пока не настроен. Добавь OPENAI_API_KEY или используй кнопки.",
        mainMenu(),
      );
      return;
    }
    if (ctx.message.voice.duration > config.voiceMaxSeconds) {
      await showScreen(
        ctx,
        `Голосовое сообщение слишком длинное. Максимум: ${config.voiceMaxSeconds} сек.`,
        mainMenu(),
      );
      return;
    }
    try {
      await showScreen(ctx, "Распознаю голосовое сообщение…", cancelKeyboard());
      const [file, accounts, categories] = await Promise.all([
        ctx.api.getFile(ctx.message.voice.file_id),
        service.getAccounts(chatId(ctx)),
        service.getCategories(chatId(ctx)),
      ]);
      if (!file.file_path) throw new Error("Telegram не вернул путь к голосовому файлу.");
      const response = await fetch(
        `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`,
      );
      if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.byteLength > 20 * 1024 * 1024) {
        throw new UserFacingError("Голосовой файл больше 20 МБ. Отправь более короткое сообщение.");
      }
      const transcript = await naturalInput.transcribe(
        audio,
        "telegram-voice.ogg",
        [...accounts.map((account) => account.name), ...categories],
      );
      if (!transcript) throw new UserFacingError("Не удалось распознать речь. Попробуй ещё раз.");
      await processNaturalText(ctx, transcript);
    } catch (error) {
      await replyError(ctx, error);
    }
  });

  bot.callbackQuery("account:currency:other", async (ctx) => {
    await ctx.answerCallbackQuery();
    const flow = ctx.session.flow;
    if (flow.kind !== "account_currency") return;
    await showScreen(
      ctx,
      `Новый счёт · 3/4\n${flow.name}\n\nОтправь трёхбуквенный код валюты, например EUR.`,
      cancelKeyboard(),
    );
  });

  bot.catch(({ error, ctx }) => replyError(ctx, error));
  return bot;
}
