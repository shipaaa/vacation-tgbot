import type {
  Account,
  AccountBalance,
  ExchangeRates,
  StoredTransaction,
  SummaryLine,
} from "./types.js";

export interface ConversionInput {
  purchaseAmount: number;
  purchaseCurrency: string;
  accountAmount: number;
  accountCurrency: string;
  accountRubRate: number;
  rates: ExchangeRates;
}

export interface ConvertedAmounts {
  amountRub: number | null;
  amountUsd: number | null;
  amountJpy: number | null;
  usdJpyRate: number | null;
  usdRubRate: number | null;
  jpyRubRate: number | null;
}

function parseNumber(input: string): number | null {
  const normalized = input
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");

  if (!normalized || !/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function parseAmount(input: string): number | null {
  const value = parseNumber(input);
  return value !== null && value > 0 ? value : null;
}

export function parseSignedAmount(input: string): number | null {
  return parseNumber(input);
}

export function convertAmounts(input: ConversionInput): ConvertedAmounts {
  const purchaseCurrency = input.purchaseCurrency.toUpperCase();
  const accountCurrency = input.accountCurrency.toUpperCase();
  const accountRubRate = accountCurrency === "RUB" ? 1 : positive(input.accountRubRate);
  const amountRub = accountRubRate
    ? input.accountAmount * accountRubRate
    : null;
  const amountUsd =
    purchaseCurrency === "USD"
      ? input.purchaseAmount
      : accountCurrency === "USD"
        ? input.accountAmount
        : amountRub && input.rates.usdRub
          ? amountRub / input.rates.usdRub
          : null;
  const amountJpy =
    purchaseCurrency === "JPY"
      ? input.purchaseAmount
      : accountCurrency === "JPY"
        ? input.accountAmount
        : amountRub && input.rates.jpyRub
          ? amountRub / input.rates.jpyRub
          : null;

  const usdRubRate =
    amountUsd && amountRub
      ? amountRub / amountUsd
      : positive(input.rates.usdRub);
  const jpyRubRate =
    amountJpy && amountRub
      ? amountRub / amountJpy
      : positive(input.rates.jpyRub);
  const usdJpyRate =
    amountUsd && amountJpy
      ? amountJpy / amountUsd
      : usdRubRate && jpyRubRate
        ? usdRubRate / jpyRubRate
        : null;

  return {
    amountRub,
    amountUsd,
    amountJpy,
    usdJpyRate,
    usdRubRate: usdRubRate ?? positive(input.rates.usdRub),
    jpyRubRate: jpyRubRate ?? positive(input.rates.jpyRub),
  };
}

export function computeBalances(
  accounts: Account[],
  transactions: StoredTransaction[],
): AccountBalance[] {
  const activeTransactions = transactions.filter((transaction) => !transaction.deletedAt);

  return accounts
    .filter((account) => account.active)
    .map((account) => {
      const movement = activeTransactions
        .filter((transaction) => transaction.accountId === account.id)
        .reduce(
          (sum, transaction) =>
            sum + (transaction.type === "income" ? transaction.amount : -transaction.amount),
          0,
        );
      return { ...account, balance: account.openingBalance + movement };
    });
}

export function summarizeExpenses(
  transactions: StoredTransaction[],
  baseCurrency: string,
  date?: string,
): SummaryLine[] {
  const normalizedBase = baseCurrency.toUpperCase();
  const grouped = new Map<string, { amountBase: number; amountRub: number }>();

  for (const transaction of transactions) {
    if (transaction.deletedAt || transaction.type !== "expense") continue;
    if (date && transaction.date !== date) continue;
    const amountRub = amountInCurrency(transaction, "RUB");
    const amountBase = amountInCurrency(transaction, normalizedBase);
    if (amountRub === null || amountBase === null) continue;
    const current = grouped.get(transaction.category) ?? { amountBase: 0, amountRub: 0 };
    grouped.set(transaction.category, {
      amountBase: current.amountBase + amountBase,
      amountRub: current.amountRub + amountRub,
    });
  }

  return [...grouped.entries()]
    .map(([label, amounts]) => ({ label, baseCurrency: normalizedBase, ...amounts }))
    .sort((left, right) => right.amountRub - left.amountRub);
}

export function amountInCurrency(
  transaction: StoredTransaction,
  currency: string,
): number | null {
  const target = currency.toUpperCase();
  if (target === "RUB") {
    if (transaction.amountRub !== null) return transaction.amountRub;
  }
  if (target === "USD") {
    if (transaction.amountUsd !== null) return transaction.amountUsd;
    if (transaction.amountRub !== null && transaction.usdRubRate) {
      return transaction.amountRub / transaction.usdRubRate;
    }
  }
  if (target === "JPY") {
    if (transaction.amountJpy !== null) return transaction.amountJpy;
    if (transaction.amountRub !== null && transaction.jpyRubRate) {
      return transaction.amountRub / transaction.jpyRubRate;
    }
  }
  if (transaction.purchaseCurrency.toUpperCase() === target) return transaction.purchaseAmount;
  if (transaction.currency.toUpperCase() === target) return transaction.amount;
  return null;
}

export function formatMoney(amount: number, currency: string): string {
  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 2,
  }).format(amount)} ${currency}`;
}

function positive(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : null;
}
