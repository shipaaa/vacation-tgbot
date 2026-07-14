export type DirectTransactionType = "expense" | "income";
export type TransactionType = DirectTransactionType | "transfer_out" | "transfer_in";
export type AccountKind = "cash" | "card" | "other";
export type MoneySyncStatus = "pending" | "synced" | "not_applicable" | "failed";

export interface SheetConnection {
  spreadsheetId: string;
  title: string;
  connectedAt: string;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingBalance: number;
  rubRate: number;
  active: boolean;
}

export interface ExchangeRates {
  usdRub: number | null;
  jpyRub: number | null;
}

export interface TravelTransaction {
  id: string;
  createdAt: string;
  date: string;
  type: TransactionType;
  accountId: string;
  accountName: string;
  amount: number;
  currency: string;
  purchaseAmount: number;
  purchaseCurrency: string;
  amountRub: number | null;
  amountUsd: number | null;
  amountJpy: number | null;
  usdJpyRate: number | null;
  usdRubRate: number | null;
  jpyRubRate: number | null;
  category: string;
  description: string;
  telegramUser: string;
  chatId: string;
  deletedAt: string;
  moneySyncStatus: MoneySyncStatus;
  moneySyncError: string;
  moneySyncedAt: string;
  transferId: string;
}

export interface StoredTransaction extends TravelTransaction {
  rowNumber: number;
}

export interface AccountBalance extends Account {
  balance: number;
}

export interface SummaryLine {
  label: string;
  baseCurrency: string;
  amountBase: number;
  amountRub: number;
}
