import {
  Bot,
  Context,
  InlineKeyboard,
  session,
  type SessionFlavor,
} from "grammy";
import type { AppConfig } from "./config.js";
import { formatMoney, parseAmount, parseSignedAmount } from "./domain/money.js";
import type { AccountKind, TransactionType } from "./domain/types.js";
import { TravelService, UserFacingError } from "./services/travelService.js";

export const BOT_COMMANDS = [
  { command: "start", description: "Открыть панель" },
  { command: "expense", description: "Новый расход" },
  { command: "income", description: "Пополнить счёт" },
  { command: "accounts", description: "Счета и остатки" },
  { command: "summary", description: "Сводка расходов" },
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
      type: TransactionType;
      accountId: string;
      accountAmount: number;
      purchaseAmount: number;
      purchaseCurrency: string;
      category: string;
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
  | { kind: "home_timezone" };

interface BotSession {
  flow: Flow;
  screenMessageId?: number;
}

type BotContext = Context & SessionFlavor<BotSession>;

const HOME_TIMEZONES = [
  { label: "Москва", timezone: "Europe/Moscow" },
  { label: "Калининград", timezone: "Europe/Kaliningrad" },
  { label: "Екатеринбург", timezone: "Asia/Yekaterinburg" },
  { label: "Новосибирск", timezone: "Asia/Novosibirsk" },
  { label: "Владивосток", timezone: "Asia/Vladivostok" },
  { label: "Дубай", timezone: "Asia/Dubai" },
  { label: "Токио", timezone: "Asia/Tokyo" },
  { label: "Лондон", timezone: "Europe/London" },
  { label: "Нью-Йорк", timezone: "America/New_York" },
] as const;

function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("＋ Расход", "menu:expense")
    .text("＋ Пополнение", "menu:income")
    .row()
    .text("◉ Счета", "menu:accounts")
    .text("▥ Сводка", "menu:summary")
    .row()
    .text("✈ Поездки", "menu:trips")
    .text("⚙ Настройки", "menu:settings")
    .row()
    .text("↶ Отменить последнюю операцию", "menu:undo");
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("× Отменить", "flow:cancel");
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("← Назад", "menu:home");
}

function descriptionKeyboard(defaultName?: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(defaultName ? `Оставить «${defaultName}»` : "Без комментария", "tx:skip")
    .row()
    .text("× Отменить", "flow:cancel");
}

function homeTimezoneKeyboard(currentTimezone: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  HOME_TIMEZONES.forEach((item, index) => {
    const prefix = item.timezone === currentTimezone ? "✓ " : "";
    keyboard.text(`${prefix}${item.label}`, `settings:home:${index}`);
    if (index % 2 === 1) keyboard.row();
  });
  keyboard
    .row()
    .text("Другой город", "settings:home:custom")
    .row()
    .text("← Назад", "menu:settings");
  return keyboard;
}

function homeTimezoneLabel(timezone: string): string {
  return HOME_TIMEZONES.find((item) => item.timezone === timezone)?.label ?? timezone;
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
    .text("JPY", "settings:base:JPY")
    .text("USD", "settings:base:USD")
    .text("RUB", "settings:base:RUB")
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

function formatRate(rate: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 }).format(rate);
}

async function showScreen(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard = mainMenu(),
): Promise<void> {
  const callbackMessageId = ctx.callbackQuery?.message?.message_id;
  const targetMessageId = callbackMessageId ?? ctx.session.screenMessageId;
  if (targetMessageId && ctx.chat) {
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

async function replyError(ctx: BotContext, error: unknown): Promise<void> {
  ctx.session.flow = { kind: "idle" };
  if (error instanceof UserFacingError) {
    await showScreen(ctx, error.message);
    return;
  }
  console.error(error);
  await showScreen(ctx, "Неожиданная ошибка. Подробности записаны в лог.");
}

export function createBot(config: AppConfig, service: TravelService): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.telegramBotToken);
  bot.use(session({ initial: (): BotSession => ({ flow: { kind: "idle" } }) }));

  bot.use(async (ctx, next) => {
    if (
      config.allowedTelegramUserIds.size &&
      (!ctx.from || !config.allowedTelegramUserIds.has(ctx.from.id))
    ) {
      await ctx.reply("У этого пользователя нет доступа к боту.");
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    await deleteIncomingMessage(ctx);
    await next();
  });

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
    const [baseCurrency, balances, today, homeTimezone] = await Promise.all([
      service.getBaseCurrency(chatId(ctx)),
      service.getBalances(chatId(ctx)),
      service.getSummary(chatId(ctx), true),
      service.getHomeTimezone(chatId(ctx)),
    ]);
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
    const lines = [
      ...(notice ? [notice, ""] : []),
      `✈ ${connection.title}`,
      `${homeTimezoneLabel(homeTimezone)}: ${formatTime(homeTimezone)}`,
      todayLine,
      "",
      "Остатки",
      ...balanceLines,
      ...(balances.length > 4 ? [`• Ещё счетов: ${balances.length - 4}`] : []),
    ];
    await showScreen(ctx, lines.join("\n"), mainMenu());
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
      keyboard.row().text("← Назад", "menu:home");
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
          .text("× Отменить", "flow:cancel"),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendAccounts(ctx: BotContext, notice = ""): Promise<void> {
    try {
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
        .text("← Назад", "menu:home");
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
      const period = todayOnly ? `сегодня, ${summary.date}` : "вся поездка";
      const total = lines.length
        ? `\nИтого: ${formatMoney(totals.base, summary.baseCurrency)}` +
          (showRub ? ` · ${formatMoney(totals.rub, "RUB")}` : "")
        : "";
      const keyboard = new InlineKeyboard()
        .text(todayOnly ? "✓ Сегодня" : "Сегодня", "summary:today")
        .text(todayOnly ? "Вся поездка" : "✓ Вся поездка", "summary:all")
        .row()
        .text("← Назад", "menu:home");
      await showScreen(ctx, [
        `Сводка · ${period}\n${connection?.title ?? "Поездка"}`,
        "",
        ...(lines.length ? lines : ["Расходов пока нет."]),
        ...(total ? [total.trimStart()] : []),
      ].join("\n"), keyboard);
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  async function sendRates(ctx: BotContext, notice = ""): Promise<void> {
    try {
      const rates = await service.getRates(chatId(ctx));
      const value = (rate: number | null) => (rate ? formatRate(rate) : "не задан");
      await showScreen(
        ctx,
        [
          notice,
          "Курсы\nДля будущих операций",
          `1 USD = ${value(rates.usdRub)} RUB`,
          `1 JPY = ${value(rates.jpyRub)} RUB`,
          "",
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
      const [baseCurrency, homeTimezone] = await Promise.all([
        service.getBaseCurrency(chatId(ctx)),
        service.getHomeTimezone(chatId(ctx)),
      ]);
      await showScreen(
        ctx,
        [
          ...(notice ? [notice, ""] : []),
          "Настройки",
          `Базовая валюта поездки: ${baseCurrency}`,
          `Домашнее время: ${homeTimezoneLabel(homeTimezone)} · ${formatTime(homeTimezone)}`,
        ]
          .join("\n"),
        new InlineKeyboard()
          .text("Базовая валюта", "settings:base")
          .row()
          .text("Домашнее время", "settings:home")
          .row()
          .text("Курсы валют", "menu:rates")
          .row()
          .text("← Назад", "menu:home"),
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

  async function chooseAccount(ctx: BotContext, type: TransactionType): Promise<void> {
    try {
      const accounts = await service.getBalances(chatId(ctx));
      if (!accounts.length) {
        await showScreen(
          ctx,
          "Сначала добавь счёт.",
          new InlineKeyboard().text("＋ Добавить счёт", "account:add").row().text("← Назад", "menu:home"),
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
      keyboard.row().text("× Отменить", "flow:cancel");
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
    keyboard.row().text("× Отменить", "flow:cancel");
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
    try {
      const transaction = await service.recordTransaction({
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
      if (transaction.purchaseCurrency !== "RUB") {
        lines.push(`≈ ${formatMoney(transaction.amountRub ?? 0, "RUB")}`);
        if (transaction.purchaseCurrency !== "USD" && transaction.amountUsd !== null) {
          lines.push(`≈ ${formatMoney(transaction.amountUsd, "USD")}`);
        }
      }
      await showScreen(ctx, lines.join("\n"), mainMenu());
    } catch (error) {
      await replyError(ctx, error);
    }
  }

  bot.command("start", (ctx) => sendMain(ctx));
  bot.command("help", (ctx) =>
    showScreen(
      ctx,
      "Как пользоваться\n\n" +
        "Все действия находятся на кнопках панели. Текст понадобится только для суммы, названия или комментария. После обработки бот уберёт его из чата.\n\n" +
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
  bot.command("today", (ctx) => sendSummary(ctx, true));
  bot.command("rates", (ctx) => sendRates(ctx));
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
  bot.callbackQuery("summary:today", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSummary(ctx, true);
  });
  bot.callbackQuery("summary:all", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSummary(ctx, false);
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
  bot.callbackQuery("menu:undo", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showScreen(
      ctx,
      "Отменить последнюю операцию?\n\nРасход также исчезнет из Money, а баланс будет пересчитан.",
      new InlineKeyboard()
        .text("↶ Да, отменить", "undo:confirm")
        .row()
        .text("← Назад", "menu:home"),
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

  bot.callbackQuery("tx:skip", async (ctx) => {
    await ctx.answerCallbackQuery();
    await completeTransaction(ctx, "");
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

  bot.callbackQuery(/^tx:account:(expense|income):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const type = ctx.match[1] as TransactionType;
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
      keyboard.row().text("× Отменить", "flow:cancel");
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
    await showScreen(ctx, "Базовая валюта страны поездки:", baseCurrencyKeyboard());
  });
  bot.callbackQuery("settings:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const timezone = await service.getHomeTimezone(chatId(ctx));
      await showScreen(
        ctx,
        `Домашнее время\n\nСейчас: ${homeTimezoneLabel(timezone)} · ${formatTime(timezone)}`,
        homeTimezoneKeyboard(timezone),
      );
    } catch (error) {
      await replyError(ctx, error);
    }
  });
  bot.callbackQuery("settings:home:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.flow = { kind: "home_timezone" };
    await showScreen(
      ctx,
      "Домашнее время\n\nОтправь часовой пояс в формате Region/City.\nНапример: Europe/Paris или Asia/Almaty.",
      cancelKeyboard(),
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
  bot.callbackQuery(/^settings:base:(JPY|USD|RUB)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const currency = await service.setBaseCurrency(chatId(ctx), ctx.match[1]);
      await sendSettings(ctx, `Базовая валюта изменена на ${currency}.`);
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
            .text("× Отменить", "flow:cancel"),
        );
        return;
      }
      if (flow.kind === "account_currency") {
        const currency = text.toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
          await showScreen(ctx, "Нужен код из трёх латинских букв, например JPY.", cancelKeyboard());
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
          const rates = await service.getRates(chatId(ctx));
          const rubRate = flow.currency === "USD"
            ? rates.usdRub
            : flow.currency === "JPY"
              ? rates.jpyRub
              : null;
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
      if (flow.kind === "home_timezone") {
        const timezone = await service.setHomeTimezone(chatId(ctx), text);
        ctx.session.flow = { kind: "idle" };
        await sendSettings(
          ctx,
          `✓ Домашнее время: ${homeTimezoneLabel(timezone)} · ${formatTime(timezone)}`,
        );
        return;
      }
      await sendMain(ctx);
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
