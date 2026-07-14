import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { normalizeCurrencyCode } from "../domain/currency.js";

const naturalCommandSchema = z.object({
  intent: z.enum(["expense", "income", "transfer", "balance", "summary", "unknown"]),
  amount: z.number().positive().nullable(),
  currency: z.string().nullable(),
  accountName: z.string().nullable(),
  accountAmount: z.number().positive().nullable(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  destinationAccountName: z.string().nullable(),
  destinationAmount: z.number().positive().nullable(),
  destinationCurrency: z.string().nullable(),
  period: z.enum(["today", "trip"]).nullable(),
});

export type NaturalCommand = z.infer<typeof naturalCommandSchema>;

export interface NaturalInputContext {
  tripName: string;
  baseCurrency: string;
  accounts: Array<{ name: string; currency: string }>;
  categories: string[];
}

export class NaturalInputUnavailableError extends Error {}

export class OpenAINaturalInput {
  private readonly client: OpenAI | null;

  constructor(private readonly config: AppConfig) {
    this.client = config.openaiApiKey
      ? new OpenAI({ apiKey: config.openaiApiKey })
      : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async transcribe(
    audio: Uint8Array,
    fileName: string,
    vocabulary: string[],
  ): Promise<string> {
    if (!this.client) throw new NaturalInputUnavailableError("Голосовой ввод не настроен.");
    const response = await this.client.audio.transcriptions.create({
      file: await toFile(audio, fileName, { type: "audio/ogg" }),
      model: this.config.openaiTranscribeModel,
      prompt: vocabulary.length
        ? `Финансовая запись для поездки. Возможные названия: ${vocabulary.join(", ")}.`
        : "Финансовая запись для поездки на русском языке.",
    });
    return response.text.trim();
  }

  async interpret(text: string, context: NaturalInputContext): Promise<NaturalCommand> {
    if (!this.client) throw new NaturalInputUnavailableError("Естественный ввод не настроен.");
    const response = await this.client.responses.parse({
      model: this.config.openaiTextModel,
      store: false,
      instructions: [
        "Ты извлекаешь одну команду для бота учёта денег в поездке.",
        "Возвращай только поля схемы. Никогда не выдумывай сумму или счёт.",
        "Для expense amount/currency — цена покупки, accountAmount — отдельно названное фактическое списание.",
        "Для income amount — сумма пополнения.",
        "Для transfer accountName — счёт-источник, destinationAccountName — получатель; amount и destinationAmount — отправлено и получено.",
        "Используй точные названия существующих счетов и категорий из контекста, если соответствие очевидно.",
        "Категорию расхода можно разумно вывести из описания, но только из переданного списка.",
        "Если данных нет или они неоднозначны, верни null в соответствующем поле.",
        "balance означает запрос остатков, summary — расходов за сегодня или поездку.",
      ].join(" "),
      input: JSON.stringify({ text, context }),
      text: {
        format: zodTextFormat(naturalCommandSchema, "travel_budget_command"),
      },
    });
    if (!response.output_parsed) {
      throw new Error("OpenAI не вернул распознанную команду.");
    }
    return {
      ...response.output_parsed,
      currency: normalizeCurrency(response.output_parsed.currency),
      destinationCurrency: normalizeCurrency(response.output_parsed.destinationCurrency),
    };
  }

}

function normalizeCurrency(value: string | null): string | null {
  return normalizeCurrencyCode(value);
}

function normalizeName(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

export function findNamedItem<T extends { name: string }>(
  items: T[],
  requestedName: string | null,
): T | null {
  if (!requestedName) return null;
  const needle = normalizeName(requestedName);
  const exact = items.filter((item) => normalizeName(item.name) === needle);
  if (exact.length === 1) return exact[0] ?? null;
  const partial = items.filter((item) => {
    const candidate = normalizeName(item.name);
    return candidate.includes(needle) || needle.includes(candidate);
  });
  return partial.length === 1 ? partial[0] ?? null : null;
}

export function findCategory(categories: string[], requestedName: string | null): string | null {
  const match = findNamedItem(categories.map((name) => ({ name })), requestedName);
  return match?.name ?? categories.find((category) => category === "Другое") ?? null;
}
