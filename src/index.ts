import "dotenv/config";
import { BOT_COMMANDS, createBot } from "./bot.js";
import { loadConfig } from "./config.js";
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
const bot = createBot(config, service);

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
  process.once(signal, () => bot.stop());
}
