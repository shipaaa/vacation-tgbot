import { z } from "zod";

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
    GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    STATE_FILE: z.string().default("./data/state.json"),
    DEFAULT_TIMEZONE: z.string().default("UTC"),
    ALLOWED_TELEGRAM_USER_IDS: z.string().default(""),
    OPENAI_API_KEY: z.string().trim().optional().transform((value) => value || undefined),
    OPENAI_TEXT_MODEL: z.string().default("gpt-5-mini"),
    OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
    VOICE_MAX_SECONDS: z.coerce.number().int().positive().max(600).default(120),
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
  openaiApiKey?: string;
  openaiTextModel: string;
  openaiTranscribeModel: string;
  voiceMaxSeconds: number;
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
    openaiApiKey: env.OPENAI_API_KEY,
    openaiTextModel: env.OPENAI_TEXT_MODEL,
    openaiTranscribeModel: env.OPENAI_TRANSCRIBE_MODEL,
    voiceMaxSeconds: env.VOICE_MAX_SECONDS,
  };
}
