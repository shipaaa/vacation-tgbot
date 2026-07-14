import { formatDate } from "./date.js";
import type { Account, TravelTransaction } from "./types.js";

export const MANUAL_MONEY_USER = "Google Sheets";

export interface ManualMoneySyncResult {
  imported: number;
  updated: number;
  deleted: number;
  unresolved: number;
}

export type ManualMoneyParseResult =
  | { status: "ready"; transaction: TravelTransaction }
  | { status: "ignored" }
  | { status: "unresolved"; reason: string };

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function positiveNumber(value: unknown): number | null {
  const normalized = text(value).replace(/\s+/g, "").replace(",", ".");
  if (!normalized || normalized === "-") return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function moneyDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatDate(new Date(Math.floor(value - 25_569) * 86_400_000).toISOString().slice(0, 10));
  }
  const formatted = formatDate(text(value));
  return /^\d{2}\.\d{2}\.\d{4}$/.test(formatted) ? formatted : null;
}

function amountForCurrency(
  currency: string,
  amounts: { rub: number | null; usd: number | null; jpy: number | null },
): number | null {
  if (currency === "RUB") return amounts.rub;
  if (currency === "USD") return amounts.usd;
  if (currency === "JPY") return amounts.jpy;
  return null;
}

function resolveAccount(
  paymentType: string,
  accounts: Account[],
  amounts: { rub: number | null; usd: number | null; jpy: number | null },
): Account | null {
  const normalized = paymentType.toLocaleLowerCase("ru-RU");
  let candidates: Account[];
  if (normalized === "наличные") {
    candidates = accounts.filter((account) => account.kind === "cash");
  } else if (normalized === "карта ru") {
    candidates = accounts.filter(
      (account) => account.kind === "card" && account.currency.toUpperCase() === "RUB",
    );
  } else if (normalized === "карта cry") {
    const usdCards = accounts.filter(
      (account) => account.kind === "card" && account.currency.toUpperCase() === "USD",
    );
    candidates = usdCards.length ? usdCards : accounts.filter(
      (account) => account.kind === "card" && account.currency.toUpperCase() !== "RUB",
    );
  } else {
    candidates = accounts.filter(
      (account) => account.name.toLocaleLowerCase("ru-RU") === normalized,
    );
  }
  if (candidates.length === 1) return candidates[0]!;
  const withMatchingAmount = candidates.filter((account) =>
    amountForCurrency(account.currency.toUpperCase(), amounts) !== null
  );
  return withMatchingAmount.length === 1 ? withMatchingAmount[0]! : null;
}

export function transactionIdFromMoneyNote(note: string): string | null {
  return /^Telegram ([a-zA-Z0-9_-]+) ·/.exec(note.trim())?.[1] ?? null;
}

export function parseManualMoneyRow(input: {
  values: unknown[];
  accounts: Account[];
  chatId: string;
  transactionId: string;
  createdAt?: string;
  now?: string;
}): ManualMoneyParseResult {
  const status = text(input.values[2]).toLocaleLowerCase("ru-RU");
  if (status !== "оплачено") return { status: "ignored" };
  const description = text(input.values[0]);
  if (!description) return { status: "ignored" };

  const amounts = {
    rub: positiveNumber(input.values[4]),
    usd: positiveNumber(input.values[5]),
    jpy: positiveNumber(input.values[6]),
  };
  const account = resolveAccount(text(input.values[3]), input.accounts, amounts);
  if (!account) {
    return {
      status: "unresolved",
      reason: `Не удалось однозначно сопоставить вид оплаты «${text(input.values[3]) || "не указан"}» со счётом.`,
    };
  }
  const currency = account.currency.toUpperCase();
  const accountAmount = amountForCurrency(currency, amounts);
  if (!accountAmount) {
    return {
      status: "unresolved",
      reason: `В Money нет суммы в валюте счёта ${account.name} · ${currency}.`,
    };
  }
  const date = moneyDate(input.values[9]);
  if (!date) {
    return { status: "unresolved", reason: "Не указана корректная дата операции." };
  }

  const usdJpyRate = positiveNumber(input.values[7]);
  const usdRubRate = positiveNumber(input.values[8]);
  const jpyRubRate = usdJpyRate && usdRubRate ? usdRubRate / usdJpyRate : null;
  const amountRub = amounts.rub ??
    (currency === "USD" && usdRubRate ? accountAmount * usdRubRate : null) ??
    (currency === "JPY" && jpyRubRate ? accountAmount * jpyRubRate : null);
  if (!amountRub) {
    return { status: "unresolved", reason: "Не удалось определить сумму операции в RUB." };
  }
  const now = input.now ?? new Date().toISOString();
  const category = text(input.values[1]);
  return {
    status: "ready",
    transaction: {
      id: input.transactionId,
      createdAt: input.createdAt || now,
      date,
      type: "expense",
      accountId: account.id,
      accountName: account.name,
      amount: accountAmount,
      currency,
      purchaseAmount: accountAmount,
      purchaseCurrency: currency,
      amountRub,
      amountUsd: amounts.usd ?? (usdRubRate ? amountRub / usdRubRate : null),
      amountJpy: amounts.jpy ?? (jpyRubRate ? amountRub / jpyRubRate : null),
      usdJpyRate,
      usdRubRate,
      jpyRubRate,
      category: category === "Развлечение" ? "Развлечения" : category || "Другое",
      description,
      telegramUser: MANUAL_MONEY_USER,
      chatId: input.chatId,
      deletedAt: "",
      moneySyncStatus: "synced",
      moneySyncError: "",
      moneySyncedAt: now,
      transferId: "",
    },
  };
}

export function manualMoneyTransactionChanged(
  current: TravelTransaction,
  next: TravelTransaction,
): boolean {
  const keys: Array<keyof TravelTransaction> = [
    "date",
    "accountId",
    "accountName",
    "amount",
    "currency",
    "purchaseAmount",
    "purchaseCurrency",
    "amountRub",
    "amountUsd",
    "amountJpy",
    "usdJpyRate",
    "usdRubRate",
    "jpyRubRate",
    "category",
    "description",
    "deletedAt",
  ];
  return keys.some((key) => current[key] !== next[key]);
}
