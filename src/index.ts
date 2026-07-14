import "dotenv/config";
import { OpenAINaturalInput } from "./ai/naturalInput.js";
import { BOT_COMMANDS, createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { formatMoney } from "./domain/money.js";
import { createGoogleAuth } from "./google/auth.js";
import { GoogleSheetsGateway } from "./google/sheetsGateway.js";
import { TravelService } from "./services/travelService.js";
import { JsonStateStore } from "./state/jsonStore.js";

const config = loadConfig();
const { auth, serviceAccountEmail } = await createGoogleAuth(config);
const gateway = new GoogleSheetsGateway(auth);
const stateStore = new JsonStateStore(config.stateFile);
const service = new TravelService(
  gateway,
  stateStore,
  config,
  serviceAccountEmail,
);
const naturalInput = new OpenAINaturalInput(config);
const bot = createBot(config, service, naturalInput);

async function runMoneySync(): Promise<void> {
  const result = await service.syncAllPendingMoney();
  if (result.synced || result.failed) {
    console.log(`Синхронизация Money: успешно ${result.synced}, ошибок ${result.failed}.`);
  }
}

const initialization = await service.initializeAllConnections();
if (initialization.prepared || initialization.failed) {
  console.log(
    `Подготовка таблиц: успешно ${initialization.prepared}, ошибок ${initialization.failed}.`,
  );
}
await runMoneySync().catch((error) => console.error("Ошибка запуска синхронизации Money:", error));
const moneySyncTimer = setInterval(() => {
  void runMoneySync().catch((error) => console.error("Ошибка фоновой синхронизации Money:", error));
}, 60_000);
moneySyncTimer.unref();

let digestRunning = false;
async function runDailyDigests(): Promise<void> {
  if (digestRunning) return;
  digestRunning = true;
  try {
    for (const delivery of await service.getDueDigests()) {
      const dailyBudget = delivery.budgets.daily;
      const lines = [
        `Итоги дня · ${delivery.localDate}`,
        `✈ ${delivery.title}`,
        "",
        `Расходы: ${formatMoney(delivery.todaySpent, delivery.baseCurrency)}`,
        ...(dailyBudget
          ? [
              dailyBudget.remaining >= 0
                ? `Бюджет: ${Math.round(dailyBudget.percent)}% · осталось ${formatMoney(dailyBudget.remaining, delivery.baseCurrency)}`
                : `⚠ Бюджет превышен на ${formatMoney(-dailyBudget.remaining, delivery.baseCurrency)}`,
            ]
          : []),
        ...delivery.budgets.categories
          .filter((item) => item.percent >= 100)
          .map((item) =>
            `⚠ «${item.category}»: превышение ${formatMoney(-item.remaining, delivery.baseCurrency)}`
          ),
        "",
        "Остатки",
        ...delivery.balances.slice(0, 8).map((account) =>
          `• ${account.name}: ${formatMoney(account.balance, account.currency)}`
        ),
      ];
      try {
        await bot.api.sendMessage(delivery.chatId, lines.join("\n"));
        await service.markDigestSent(delivery);
      } catch (error) {
        console.error(`Ошибка отправки digest в чат ${delivery.chatId}:`, error);
      }
    }
  } finally {
    digestRunning = false;
  }
}

await runDailyDigests().catch((error) => console.error("Ошибка запуска digest:", error));
const digestTimer = setInterval(() => {
  void runDailyDigests().catch((error) => console.error("Ошибка фонового digest:", error));
}, 60_000);
digestTimer.unref();

if (!config.allowedTelegramUserIds.size) {
  console.warn("ALLOWED_TELEGRAM_USER_IDS пуст: бот доступен любому пользователю.");
}
if (serviceAccountEmail) {
  console.log(`Google service account: ${serviceAccountEmail}`);
}

await bot.api.setMyCommands([...BOT_COMMANDS]);
bot.start({
  onStart: (botInfo) => console.log(`Бот @${botInfo.username} запущен в режиме long polling.`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(moneySyncTimer);
    clearInterval(digestTimer);
    bot.stop();
  });
}
