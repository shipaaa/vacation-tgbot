import { z } from "zod";

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
    GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    STATE_FILE: z.string().default("./data/state.json"),
    DEFAULT_TIMEZONE: z.string().default("UTC"),
    ALLOWED_TELEGRAM_USER_IDS: z.string().default(""),
  })
  .refine(
    (env) => env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_SERVICE_ACCOUNT_JSON,
    "Укажите GOOGLE_APPLICATION_CREDENTIALS или GOOGLE_SERVICE_ACCOUNT_JSON",
  );

export interface AppConfig {
  telegramBotToken: string;
  googleCredentialsPath?: string;
  googleServiceAccountJson?: string;
  stateFile: string;
  defaultTimezone: string;
  allowedTelegramUserIds: Set<number>;
}

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const allowedTelegramUserIds = new Set(
    env.ALLOWED_TELEGRAM_USER_IDS.split(",")
      .map((value) => Number(value.trim()))
      .filter(Number.isSafeInteger),
  );

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    googleCredentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    stateFile: env.STATE_FILE,
    defaultTimezone: env.DEFAULT_TIMEZONE,
    allowedTelegramUserIds,
  };
}
