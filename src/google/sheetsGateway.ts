import { google, type sheets_v4 } from "googleapis";
import type {
  Account,
  AccountKind,
  ExchangeRates,
  StoredTransaction,
  TravelTransaction,
} from "../domain/types.js";
import { convertAmounts } from "../domain/money.js";
import type { GoogleAuthClient } from "./auth.js";

const SHEETS = {
  overview: "Обзор",
  transactions: "Траты",
  accounts: "Счета",
  categories: "Категории",
  settings: "Настройки",
} as const;

const DATA_START_ROW = 5;
const GRID_ROW_COUNT = 1000;
const LAYOUT_VERSION = "8";

const TRANSACTION_HEADERS = [
  "Наименование",
  "Категория",
  "Счёт",
  "Цена, ₽",
  "Цена, $",
  "Цена, ¥",
  "Курс USD/JPY",
  "Курс USD/RUB",
  "Курс JPY/RUB",
  "Дата",
  "Тип операции",
  "ID операции",
  "Создано",
  "ID счёта",
  "Сумма по счёту",
  "Валюта счёта",
  "Цена покупки",
  "Валюта покупки",
  "Пользователь Telegram",
  "ID чата",
  "Удалено",
];
const ACCOUNT_HEADERS = [
  "Счёт",
  "Тип",
  "Валюта",
  "Начальный остаток",
  "Текущий остаток",
  "Курс к RUB",
  "Активен",
  "ID счёта",
];
const CATEGORY_HEADERS = ["Категория", "Активна", "Порядок"];
const SETTINGS_HEADERS = ["Настройка", "Значение"];

const DEFAULT_CATEGORIES = [
  "Питание",
  "Транспорт",
  "Проживание",
  "Развлечения",
  "Шопинг",
  "Связь",
  "Здоровье",
  "Документы",
  "Другое",
];

const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  card: "Карта",
  cash: "Наличные",
  other: "Другое",
};

interface MoneyTableInfo {
  sheetId: number;
  tableId: string;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

const COLORS = {
  primary: "#7A1547",
  primaryDark: "#5F0E36",
  primaryLight: "#F4E5ED",
  text: "#2F2F34",
  muted: "#78747B",
  white: "#FFFFFF",
  stripe: "#FAF7F9",
  border: "#DFC9D5",
  green: "#B7E5B4",
  greenText: "#14613A",
  blue: "#B9DEF5",
  blueText: "#145A8D",
  orange: "#FFD0B3",
  orangeText: "#8A4315",
  purple: "#D8C2EE",
  purpleText: "#5A2B82",
  grey: "#E7E5E7",
  greyText: "#625E64",
  red: "#FFD0CC",
  redText: "#9A241C",
} as const;

function range(sheet: string, cells: string): string {
  return `'${sheet.replace(/'/g, "''")}'!${cells}`;
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function asNumber(value: unknown): number {
  const number = Number(asString(value).replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || asString(value).trim() === "") return null;
  const number = Number(asString(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function asBoolean(value: unknown): boolean {
  const normalized = asString(value).trim().toLowerCase();
  return !["false", "ложь", "0", "нет"].includes(normalized);
}

function accountKindFromLabel(value: unknown): AccountKind {
  const label = asString(value).trim().toLowerCase();
  if (label === "карта" || label === "card") return "card";
  if (label === "наличные" || label === "cash") return "cash";
  return "other";
}

function inferAccountKind(name: string): AccountKind {
  const normalized = name.toLowerCase();
  if (normalized.includes("налич") || normalized.includes("cash")) return "cash";
  if (normalized.includes("карт") || normalized.includes("card")) return "card";
  return "other";
}

function moneyCategory(category: string): string {
  const normalized = category === "Развлечения" ? "Развлечение" : category;
  const supported = new Set([
    "Авиабилет",
    "Проживание",
    "Питание",
    "Транспорт",
    "Развлечение",
    "Другое",
    "Шопинг",
  ]);
  return supported.has(normalized) ? normalized : "Другое";
}

function moneyPaymentType(accountName: string, currency: string): string {
  const normalized = accountName.toLowerCase();
  if (normalized.includes("налич") || normalized.includes("cash")) return "Наличные";
  if (normalized.includes("cry") || currency.toUpperCase() === "USD") return "Карта CRY";
  if (normalized.includes("ru") || currency.toUpperCase() === "RUB") return "Карта RU";
  return "Карта CRY";
}

function moneyTransactionName(transaction: TravelTransaction): string {
  return transaction.description.trim() || transaction.category;
}

function dateToSerial(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000 + 25_569;
}

function asDateString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date((value - 25_569) * 86_400_000).toISOString().slice(0, 10);
  }
  return asString(value).slice(0, 10);
}

function normalizeDateSerial(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return dateToSerial(asDateString(value));
}

function positiveNumber(value: unknown): number | null {
  const number = asNullableNumber(value);
  return number !== null && number > 0 ? number : null;
}

function rubRateForCurrency(currency: string, rates: ExchangeRates): number | null {
  const normalized = currency.toUpperCase();
  if (normalized === "RUB") return 1;
  if (normalized === "USD") return rates.usdRub;
  if (normalized === "JPY") return rates.jpyRub;
  return null;
}

function formulaSeparator(locale: string): string {
  try {
    return new Intl.NumberFormat(locale.replace("_", "-")).format(1.1).includes(",")
      ? ";"
      : ",";
  } catch {
    return ",";
  }
}

function rgb(hex: string): sheets_v4.Schema$Color {
  const value = hex.replace("#", "");
  return {
    red: Number.parseInt(value.slice(0, 2), 16) / 255,
    green: Number.parseInt(value.slice(2, 4), 16) / 255,
    blue: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

function gridRange(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
): sheets_v4.Schema$GridRange {
  return { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex };
}

function titleAndHeaderStyle(
  sheetId: number,
  visibleColumns: number,
): sheets_v4.Schema$Request[] {
  return [
    {
      mergeCells: {
        range: gridRange(sheetId, 0, 2, 0, visibleColumns),
        mergeType: "MERGE_ALL",
      },
    },
    {
      repeatCell: {
        range: gridRange(sheetId, 0, 2, 0, visibleColumns),
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(COLORS.primaryDark),
            horizontalAlignment: "LEFT",
            verticalAlignment: "MIDDLE",
            textFormat: {
              foregroundColor: rgb(COLORS.white),
              fontSize: 16,
              bold: true,
            },
          },
        },
        fields: "userEnteredFormat",
      },
    },
    {
      repeatCell: {
        range: gridRange(sheetId, 3, 4, 0, visibleColumns),
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(COLORS.primary),
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
            textFormat: {
              foregroundColor: rgb(COLORS.white),
              fontSize: 10,
              bold: true,
            },
            borders: {
              bottom: { style: "SOLID_MEDIUM", color: rgb(COLORS.primaryDark) },
            },
          },
        },
        fields: "userEnteredFormat",
      },
    },
    {
      repeatCell: {
        range: gridRange(sheetId, 4, GRID_ROW_COUNT, 0, visibleColumns),
        cell: {
          userEnteredFormat: {
            verticalAlignment: "MIDDLE",
            textFormat: { foregroundColor: rgb(COLORS.text), fontSize: 10 },
          },
        },
        fields: "userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat",
      },
    },
    {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [gridRange(sheetId, 4, GRID_ROW_COUNT, 0, visibleColumns)],
          booleanRule: {
            condition: {
              type: "CUSTOM_FORMULA",
              values: [{ userEnteredValue: "=ISEVEN(ROW())" }],
            },
            format: { backgroundColor: rgb(COLORS.stripe) },
          },
        },
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 4, hideGridlines: true },
          tabColor: rgb(COLORS.primary),
        },
        fields: "gridProperties.frozenRowCount,gridProperties.hideGridlines,tabColor",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 2 },
        properties: { pixelSize: 31 },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 3, endIndex: 4 },
        properties: { pixelSize: 34 },
        fields: "pixelSize",
      },
    },
  ];
}

function dimensionWidth(
  sheetId: number,
  startIndex: number,
  endIndex: number,
  pixelSize: number,
): sheets_v4.Schema$Request {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex, endIndex },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  };
}

function hideColumns(
  sheetId: number,
  startIndex: number,
  endIndex: number,
): sheets_v4.Schema$Request {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex, endIndex },
      properties: { hiddenByUser: true },
      fields: "hiddenByUser",
    },
  };
}

function showColumns(
  sheetId: number,
  startIndex: number,
  endIndex: number,
): sheets_v4.Schema$Request {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex, endIndex },
      properties: { hiddenByUser: false },
      fields: "hiddenByUser",
    },
  };
}

function setSheetHidden(
  sheetId: number,
  hidden: boolean,
): sheets_v4.Schema$Request {
  return {
    updateSheetProperties: {
      properties: { sheetId, hidden },
      fields: "hidden",
    },
  };
}

function conditionalTextColor(
  sheetId: number,
  columnIndex: number,
  text: string,
  background: string,
  foreground: string,
): sheets_v4.Schema$Request {
  return {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [gridRange(sheetId, 4, GRID_ROW_COUNT, columnIndex, columnIndex + 1)],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: text }] },
          format: {
            backgroundColor: rgb(background),
            textFormat: { foregroundColor: rgb(foreground), bold: true },
          },
        },
      },
    },
  };
}

function accountBalanceFormula(rowNumber: number, separator: string): string {
  return (
    `=D${rowNumber}` +
    `+SUMIFS('Траты'!$O$5:$O${separator}'Траты'!$N$5:$N${separator}$H${rowNumber}${separator}'Траты'!$K$5:$K${separator}"income"${separator}'Траты'!$U$5:$U${separator}"")` +
    `-SUMIFS('Траты'!$O$5:$O${separator}'Траты'!$N$5:$N${separator}$H${rowNumber}${separator}'Траты'!$K$5:$K${separator}"expense"${separator}'Траты'!$U$5:$U${separator}"")`
  );
}

export class GoogleSheetsGateway {
  private readonly client: sheets_v4.Sheets;

  constructor(auth: GoogleAuthClient) {
    this.client = google.sheets({ version: "v4", auth });
  }

  async initializeSpreadsheet(
    spreadsheetId: string,
    defaultTimezone: string,
  ): Promise<string> {
    const initialMetadata = await this.client.spreadsheets.get({
      spreadsheetId,
      fields: "properties(title,locale),sheets.properties(title,sheetId)",
    });
    const title = initialMetadata.data.properties?.title ?? "Поездка";
    const locale = initialMetadata.data.properties?.locale ?? "en_US";
    const existing = new Set(
      initialMetadata.data.sheets?.map((sheet) => sheet.properties?.title).filter(Boolean),
    );
    const missing = Object.values(SHEETS).filter((name) => !existing.has(name));

    if (missing.length) {
      await this.client.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: missing.map((name) => ({
            addSheet: { properties: { title: name, gridProperties: { rowCount: GRID_ROW_COUNT } } },
          })),
        },
      });
    }

    const metadata = await this.client.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(title,sheetId),conditionalFormats)",
    });
    const sheetIds = new Map(
      metadata.data.sheets
        ?.map((sheet) => [sheet.properties?.title, sheet.properties?.sheetId] as const)
        .filter((entry): entry is readonly [string, number] => Boolean(entry[0]) && entry[1] !== undefined),
    );
    const conditionalRuleCounts = new Map(
      metadata.data.sheets
        ?.map((sheet) => [
          sheet.properties?.title,
          sheet.conditionalFormats?.length ?? 0,
        ] as const)
        .filter((entry): entry is readonly [string, number] => Boolean(entry[0])),
    );

    const referenceRates = await this.getReferenceRates(spreadsheetId, existing);

    const migratedSheets = await this.migrateLegacySchema(
      spreadsheetId,
      title,
      formulaSeparator(locale),
      referenceRates,
    );
    const layoutSettings = await this.getSettings(spreadsheetId);
    const requiresLayoutRefresh = layoutSettings.get("layout_version") !== LAYOUT_VERSION;

    const layouts = [
      { name: SHEETS.overview, expectedHeader: "Остатки по счетам" },
      { name: SHEETS.transactions, expectedHeader: TRANSACTION_HEADERS[0] },
      { name: SHEETS.accounts, expectedHeader: ACCOUNT_HEADERS[0] },
      { name: SHEETS.categories, expectedHeader: CATEGORY_HEADERS[0] },
      { name: SHEETS.settings, expectedHeader: SETTINGS_HEADERS[0] },
    ];
    const setupSheets = new Set<string>(migratedSheets);
    const restyleSheets = new Set<string>(migratedSheets);
    for (const layout of layouts) {
      if (await this.needsSetup(spreadsheetId, layout.name, layout.expectedHeader)) {
        setupSheets.add(layout.name);
      }
    }
    if (requiresLayoutRefresh) {
      for (const sheetName of Object.values(SHEETS)) {
        setupSheets.add(sheetName);
        restyleSheets.add(sheetName);
      }
    }

    if (setupSheets.has(SHEETS.transactions)) {
      await this.writeTitledTable(
        spreadsheetId,
        SHEETS.transactions,
        `${title}: траты и пополнения`,
        TRANSACTION_HEADERS,
      );
    }
    if (setupSheets.has(SHEETS.accounts)) {
      await this.writeTitledTable(
        spreadsheetId,
        SHEETS.accounts,
        `${title}: счета и остатки`,
        ACCOUNT_HEADERS,
      );
    }
    if (setupSheets.has(SHEETS.categories)) {
      await this.writeTitledTable(
        spreadsheetId,
        SHEETS.categories,
        "Категории расходов",
        CATEGORY_HEADERS,
      );
    }
    if (setupSheets.has(SHEETS.settings)) {
      await this.writeTitledTable(
        spreadsheetId,
        SHEETS.settings,
        "Настройки поездки",
        SETTINGS_HEADERS,
      );
    }

    const categories = await this.getCategories(spreadsheetId);
    if (!categories.length) {
      await this.client.spreadsheets.values.update({
        spreadsheetId,
        range: range(SHEETS.categories, `A${DATA_START_ROW}:C${DATA_START_ROW + DEFAULT_CATEGORIES.length - 1}`),
        valueInputOption: "RAW",
        requestBody: {
          values: DEFAULT_CATEGORIES.map((name, index) => [name, true, index + 1]),
        },
      });
    }

    const settings = await this.getSettings(spreadsheetId);
    const defaultSettings = [
      ["trip_name", title],
      ["timezone", defaultTimezone],
      ["home_timezone", "Europe/Moscow"],
      ["base_currency", "RUB"],
      ["usd_rub_rate", referenceRates.usdRub ? String(referenceRates.usdRub) : ""],
      ["jpy_rub_rate", referenceRates.jpyRub ? String(referenceRates.jpyRub) : ""],
      ["schema_version", "3"],
      ["layout_version", LAYOUT_VERSION],
    ].filter(([key]) => !settings.has(key));
    if (defaultSettings.length) {
      await this.client.spreadsheets.values.append({
        spreadsheetId,
        range: range(SHEETS.settings, `A${DATA_START_ROW}:B`),
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: defaultSettings },
      });
    }

    if (setupSheets.has(SHEETS.overview) || migratedSheets.size > 0) {
      await this.writeOverview(spreadsheetId, title, formulaSeparator(locale));
    }
    const hasMoneyLedger = Boolean(await this.getMoneyTable(spreadsheetId));

    const styleRequests: sheets_v4.Schema$Request[] = [];
    for (const sheetName of setupSheets) {
      const sheetId = sheetIds.get(sheetName);
      if (sheetId === undefined) throw new Error(`Не найден созданный лист «${sheetName}».`);
      if (restyleSheets.has(sheetName)) {
        for (
          let index = (conditionalRuleCounts.get(sheetName) ?? 0) - 1;
          index >= 0;
          index -= 1
        ) {
          styleRequests.push({
            deleteConditionalFormatRule: { sheetId, index },
          });
        }
        styleRequests.push({
          unmergeCells: {
            range: gridRange(sheetId, 0, GRID_ROW_COUNT, 0, TRANSACTION_HEADERS.length),
          },
        });
      }
      styleRequests.push(...this.styleRequests(sheetName, sheetId));
    }
    if (hasMoneyLedger) {
      const botOverviewId = sheetIds.get(SHEETS.overview);
      if (botOverviewId !== undefined) {
        styleRequests.push(setSheetHidden(botOverviewId, true));
      }
    }
    if (styleRequests.length) {
      await this.client.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: styleRequests },
      });
    }
    if (
      layoutSettings.has("layout_version") &&
      layoutSettings.get("layout_version") !== LAYOUT_VERSION
    ) {
      await this.setSetting(spreadsheetId, "layout_version", LAYOUT_VERSION);
    }

    return title;
  }

  async refreshOverview(spreadsheetId: string): Promise<void> {
    const metadata = await this.client.spreadsheets.get({
      spreadsheetId,
      fields: "properties(title,locale)",
    });
    const separator = formulaSeparator(metadata.data.properties?.locale ?? "en_US");
    await this.writeOverview(
      spreadsheetId,
      metadata.data.properties?.title ?? "Поездка",
      separator,
    );
  }

  async getAccounts(spreadsheetId: string): Promise<Account[]> {
    const rows = await this.getValues(spreadsheetId, range(SHEETS.accounts, `A${DATA_START_ROW}:H`));
    return rows
      .filter((row) => asString(row[0]) && asString(row[7]))
      .map((row) => ({
        id: asString(row[7]),
        name: asString(row[0]),
        kind: accountKindFromLabel(row[1]),
        currency: asString(row[2]).toUpperCase(),
        openingBalance: asNumber(row[3]),
        rubRate: asNumber(row[5]),
        active: asBoolean(row[6]),
      }))
      .filter((account) => account.active);
  }

  async addAccount(spreadsheetId: string, account: Account): Promise<void> {
    const response = await this.client.spreadsheets.values.append({
      spreadsheetId,
      range: range(SHEETS.accounts, `A${DATA_START_ROW}:H`),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          account.name,
          ACCOUNT_KIND_LABELS[account.kind],
          account.currency,
          account.openingBalance,
          "",
          account.rubRate,
          account.active,
          account.id,
        ]],
      },
    });
    const rowNumber = rowNumberFromUpdatedRange(response.data.updates?.updatedRange);
    const locale = await this.getSpreadsheetLocale(spreadsheetId);
    const separator = formulaSeparator(locale);
    const formula = accountBalanceFormula(rowNumber, separator);
    await this.client.spreadsheets.values.update({
      spreadsheetId,
      range: range(SHEETS.accounts, `E${rowNumber}`),
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[formula]] },
    });
  }

  async updateAccountRates(
    spreadsheetId: string,
    currency: string,
    rubRate: number,
  ): Promise<void> {
    const rows = await this.getValues(
      spreadsheetId,
      range(SHEETS.accounts, `A${DATA_START_ROW}:H`),
    );
    const updates = rows.flatMap((row, index) =>
      asString(row[2]).toUpperCase() === currency.toUpperCase() && asString(row[7])
        ? [{
            range: range(SHEETS.accounts, `F${DATA_START_ROW + index}`),
            values: [[rubRate]],
          }]
        : [],
    );
    if (!updates.length) return;
    await this.client.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: updates },
    });
  }

  async getCategories(spreadsheetId: string): Promise<string[]> {
    const rows = await this.getValues(spreadsheetId, range(SHEETS.categories, `A${DATA_START_ROW}:C`));
    return rows
      .filter((row) => asString(row[0]) && asBoolean(row[1]))
      .sort((left, right) => asNumber(left[2]) - asNumber(right[2]))
      .map((row) => asString(row[0]));
  }

  async appendTransaction(
    spreadsheetId: string,
    transaction: TravelTransaction,
  ): Promise<void> {
    await this.client.spreadsheets.values.append({
      spreadsheetId,
      range: range(SHEETS.transactions, `A${DATA_START_ROW}:U`),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          moneyTransactionName(transaction),
          transaction.category,
          transaction.accountName,
          transaction.amountRub,
          transaction.amountUsd,
          transaction.amountJpy,
          transaction.usdJpyRate,
          transaction.usdRubRate,
          transaction.jpyRubRate,
          dateToSerial(transaction.date),
          transaction.type,
          transaction.id,
          transaction.createdAt,
          transaction.accountId,
          transaction.amount,
          transaction.currency,
          transaction.purchaseAmount,
          transaction.purchaseCurrency,
          transaction.telegramUser,
          transaction.chatId,
          transaction.deletedAt,
        ]],
      },
    });
    if (transaction.type === "expense") {
      try {
        await this.appendExpenseToMoney(spreadsheetId, transaction);
      } catch (error) {
        console.error("Не удалось отразить расход на листе Money:", error);
      }
    }
  }

  async appendExpenseToMoney(
    spreadsheetId: string,
    transaction: TravelTransaction,
  ): Promise<boolean> {
    if (transaction.type !== "expense") return false;
    const table = await this.getMoneyTable(spreadsheetId);
    if (!table) return false;

    const targetRowNumber = table.endRowIndex + 1;
    await this.client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: table.sheetId,
                dimension: "ROWS",
                startIndex: table.endRowIndex,
                endIndex: table.endRowIndex + 1,
              },
              inheritFromBefore: true,
            },
          },
          {
            updateTable: {
              table: {
                tableId: table.tableId,
                range: {
                  sheetId: table.sheetId,
                  startRowIndex: table.startRowIndex,
                  endRowIndex: table.endRowIndex + 1,
                  startColumnIndex: table.startColumnIndex,
                  endColumnIndex: table.endColumnIndex,
                },
              },
              fields: "range",
            },
          },
        ],
      },
    });

    const paymentType = moneyPaymentType(transaction.accountName, transaction.currency);
    const paymentRate = paymentType === "Наличные"
      ? transaction.jpyRubRate
      : transaction.usdRubRate;
    await this.client.spreadsheets.values.update({
      spreadsheetId,
      range: range("Money", `A${targetRowNumber}:K${targetRowNumber}`),
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          moneyTransactionName(transaction),
          moneyCategory(transaction.category),
          "Оплачено",
          paymentType,
          transaction.amountRub,
          transaction.amountUsd ?? "-",
          transaction.amountJpy ?? "-",
          transaction.usdJpyRate ?? "-",
          paymentRate ?? "-",
          dateToSerial(transaction.date),
          "",
        ]],
      },
    });
    await this.client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateCells: {
            start: {
              sheetId: table.sheetId,
              rowIndex: table.endRowIndex,
              columnIndex: 10,
            },
            rows: [{
              values: [{
                note: `Telegram ${transaction.id} · ${transaction.telegramUser} · ${transaction.accountName}`,
              }],
            }],
            fields: "note",
          },
        }],
      },
    });
    return true;
  }

  async getTransactions(spreadsheetId: string): Promise<StoredTransaction[]> {
    const rows = await this.getValues(spreadsheetId, range(SHEETS.transactions, `A${DATA_START_ROW}:U`));
    return rows
      .map<StoredTransaction>((row, index) => ({
        id: asString(row[11]),
        createdAt: asString(row[12]),
        date: asDateString(row[9]),
        type: asString(row[10]) === "income" ? "income" : "expense",
        accountId: asString(row[13]),
        accountName: asString(row[2]),
        amount: asNumber(row[14]),
        currency: asString(row[15]),
        purchaseAmount: asNumber(row[16]),
        purchaseCurrency: asString(row[17]),
        amountRub: asNullableNumber(row[3]),
        amountUsd: asNullableNumber(row[4]),
        amountJpy: asNullableNumber(row[5]),
        usdJpyRate: asNullableNumber(row[6]),
        usdRubRate: asNullableNumber(row[7]),
        jpyRubRate: asNullableNumber(row[8]),
        category: asString(row[1]),
        description: asString(row[0]),
        telegramUser: asString(row[18]),
        chatId: asString(row[19]),
        deletedAt: asString(row[20]),
        rowNumber: index + DATA_START_ROW,
      }))
      .filter((transaction) => transaction.id);
  }

  async markTransactionDeleted(
    spreadsheetId: string,
    transaction: StoredTransaction,
    deletedAt: string,
  ): Promise<void> {
    const metadata = await this.client.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties(title,sheetId)",
    });
    const transactionsSheetId = metadata.data.sheets?.find(
      (sheet) => sheet.properties?.title === SHEETS.transactions,
    )?.properties?.sheetId;
    if (typeof transactionsSheetId !== "number") {
      throw new Error(`Не найден служебный лист «${SHEETS.transactions}».`);
    }

    const requests: sheets_v4.Schema$Request[] = [{
      updateCells: {
        start: {
          sheetId: transactionsSheetId,
          rowIndex: transaction.rowNumber - 1,
          columnIndex: 20,
        },
        rows: [{ values: [{ userEnteredValue: { stringValue: deletedAt } }] }],
        fields: "userEnteredValue",
      },
    }];

    if (transaction.type === "expense") {
      const table = await this.getMoneyTable(spreadsheetId);
      if (table) {
        const moneyRowIndex = await this.findMoneyTransactionRow(
          spreadsheetId,
          table,
          transaction.id,
        );
        if (moneyRowIndex !== null) {
          requests.push(
            {
              deleteDimension: {
                range: {
                  sheetId: table.sheetId,
                  dimension: "ROWS",
                  startIndex: moneyRowIndex,
                  endIndex: moneyRowIndex + 1,
                },
              },
            },
            {
              updateTable: {
                table: {
                  tableId: table.tableId,
                  range: {
                    sheetId: table.sheetId,
                    startRowIndex: table.startRowIndex,
                    endRowIndex: table.endRowIndex - 1,
                    startColumnIndex: table.startColumnIndex,
                    endColumnIndex: table.endColumnIndex,
                  },
                },
                fields: "range",
              },
            },
          );
        }
      }
    }

    await this.client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  async getSettings(spreadsheetId: string): Promise<Map<string, string>> {
    const rows = await this.getValues(spreadsheetId, range(SHEETS.settings, `A${DATA_START_ROW}:B`));
    return new Map(
      rows
        .filter((row) => asString(row[0]))
        .map((row) => [asString(row[0]), asString(row[1])]),
    );
  }

  async setSetting(
    spreadsheetId: string,
    key: string,
    value: string,
  ): Promise<void> {
    const rows = await this.getValues(
      spreadsheetId,
      range(SHEETS.settings, `A${DATA_START_ROW}:B`),
    );
    const index = rows.findIndex((row) => asString(row[0]) === key);
    if (index >= 0) {
      await this.client.spreadsheets.values.update({
        spreadsheetId,
        range: range(SHEETS.settings, `B${DATA_START_ROW + index}`),
        valueInputOption: "RAW",
        requestBody: { values: [[value]] },
      });
      return;
    }
    await this.client.spreadsheets.values.append({
      spreadsheetId,
      range: range(SHEETS.settings, `A${DATA_START_ROW}:B`),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[key, value]] },
    });
  }

  private async needsSetup(
    spreadsheetId: string,
    sheetName: string,
    expectedHeader: string,
  ): Promise<boolean> {
    const rows = await this.getValues(spreadsheetId, range(sheetName, "A1:M5"));
    if (!rows.some((row) => row.some((cell) => asString(cell)))) return true;
    if (asString(rows[3]?.[0]) === expectedHeader) return false;
    throw new Error(
      `Лист «${sheetName}» уже существует и не похож на лист бота. ` +
        "Переименуй его и повтори подключение, чтобы бот ничего не перезаписал.",
    );
  }

  private async migrateLegacySchema(
    spreadsheetId: string,
    title: string,
    separator: string,
    referenceRates: ExchangeRates,
  ): Promise<Set<string>> {
    const [transactionRows, accountRows, categoryRows, settingRows] = await Promise.all([
      this.getValues(spreadsheetId, range(SHEETS.transactions, "A1:U")),
      this.getValues(spreadsheetId, range(SHEETS.accounts, "A1:H")),
      this.getValues(spreadsheetId, range(SHEETS.categories, "A1:C")),
      this.getValues(spreadsheetId, range(SHEETS.settings, "A1:B")),
    ]);

    const version1Transactions =
      asString(transactionRows[0]?.[0]) === "ID" &&
      asString(transactionRows[0]?.[1]) === "Создано";
    const version2Transactions =
      asString(transactionRows[3]?.[0]) === "Дата" &&
      asString(transactionRows[3]?.[4]) === "Сумма";
    const version1Accounts =
      asString(accountRows[0]?.[0]) === "ID" &&
      asString(accountRows[0]?.[1]) === "Название";
    const version2Accounts =
      asString(accountRows[3]?.[0]) === "Счёт" &&
      asString(accountRows[3]?.[6]) === "ID счёта";
    const version1Categories =
      asString(categoryRows[0]?.[0]) === "Название" &&
      asString(categoryRows[0]?.[1]) === "Активна";
    const version1Settings =
      asString(settingRows[0]?.[0]) === "Ключ" &&
      asString(settingRows[0]?.[1]) === "Значение";
    const version2Settings =
      asString(settingRows[3]?.[0]) === "Настройка" &&
      settingRows.slice(4).some((row) => asString(row[0]) === "schema_version" && asString(row[1]) === "2");

    const sourceSettings = version1Settings
      ? settingRows.slice(1)
      : version2Settings
        ? settingRows.slice(4)
        : [];
    const settingMap = new Map(
      sourceSettings
        .filter((row) => asString(row[0]))
        .map((row) => [asString(row[0]), asString(row[1])]),
    );
    const rates: ExchangeRates = {
      usdRub: positiveNumber(settingMap.get("usd_rub_rate")) ?? referenceRates.usdRub,
      jpyRub: positiveNumber(settingMap.get("jpy_rub_rate")) ?? referenceRates.jpyRub,
    };

    const migrated = new Set<string>();
    const updates: sheets_v4.Schema$ValueRange[] = [];
    let migratedAccountCount = 0;

    const accountSource = version1Accounts
      ? accountRows.slice(1).filter((row) => asString(row[0])).map((row) => ({
          id: asString(row[0]),
          name: asString(row[1]),
          currency: asString(row[2]).toUpperCase(),
          openingBalance: asNumber(row[3]),
          active: asBoolean(row[4]),
        }))
      : version2Accounts
        ? accountRows.slice(4).filter((row) => asString(row[6])).map((row) => ({
            id: asString(row[6]),
            name: asString(row[0]),
            currency: asString(row[2]).toUpperCase(),
            openingBalance: asNumber(row[3]),
            active: asBoolean(row[5]),
          }))
        : [];
    const accountRates = new Map(
      accountSource.map((account) => [
        account.id,
        rubRateForCurrency(account.currency, rates),
      ]),
    );

    if (version1Transactions || version2Transactions) {
      const sourceRows = version1Transactions
        ? transactionRows.slice(1).filter((row) => asString(row[0]))
        : transactionRows.slice(4).filter((row) => asString(row[7]));
      const data = sourceRows.map((row) => {
        const accountId = version1Transactions ? asString(row[4]) : asString(row[9]);
        const amount = version1Transactions ? asNumber(row[6]) : asNumber(row[4]);
        const currency = (version1Transactions ? asString(row[7]) : asString(row[5])).toUpperCase();
        const converted = convertAmounts({
          purchaseAmount: amount,
          purchaseCurrency: currency,
          accountAmount: amount,
          accountCurrency: currency,
          accountRubRate: accountRates.get(accountId) ?? rubRateForCurrency(currency, rates) ?? 0,
          rates,
        });
        return [
          version1Transactions
            ? asString(row[9]) || asString(row[8])
            : asString(row[1]),
          version1Transactions ? asString(row[8]) : asString(row[2]),
          version1Transactions ? asString(row[5]) : asString(row[3]),
          converted.amountRub,
          converted.amountUsd,
          converted.amountJpy,
          converted.usdJpyRate,
          converted.usdRubRate,
          converted.jpyRubRate,
          normalizeDateSerial(version1Transactions ? row[2] : row[0]),
          version1Transactions ? asString(row[3]) : asString(row[6]),
          version1Transactions ? asString(row[0]) : asString(row[7]),
          version1Transactions ? asString(row[1]) : asString(row[8]),
          accountId,
          amount,
          currency,
          amount,
          currency,
          version1Transactions ? asString(row[10]) : asString(row[10]),
          version1Transactions ? asString(row[11]) : asString(row[11]),
          version1Transactions ? asString(row[12]) : asString(row[12]),
        ];
      });
      updates.push({
        range: range(SHEETS.transactions, `A1:U${data.length + 4}`),
        values: titledTableValues(`${title}: траты и пополнения`, TRANSACTION_HEADERS, data),
      });
      migrated.add(SHEETS.transactions);
    }

    if (version1Accounts || version2Accounts) {
      const data = accountSource.map((account) => [
        account.name,
        ACCOUNT_KIND_LABELS[inferAccountKind(account.name)],
        account.currency,
        account.openingBalance,
        "",
        accountRates.get(account.id) ?? 0,
        account.active,
        account.id,
      ]);
      migratedAccountCount = data.length;
      updates.push({
        range: range(SHEETS.accounts, `A1:H${data.length + 4}`),
        values: titledTableValues(`${title}: счета и остатки`, ACCOUNT_HEADERS, data),
      });
      migrated.add(SHEETS.accounts);
    }

    if (version1Categories) {
      const data = categoryRows.slice(1).filter((row) => asString(row[0]));
      updates.push({
        range: range(SHEETS.categories, `A1:C${data.length + 4}`),
        values: titledTableValues("Категории расходов", CATEGORY_HEADERS, data),
      });
      migrated.add(SHEETS.categories);
    }

    if (version1Settings || version2Settings) {
      const data = sourceSettings
        .filter((row) => asString(row[0]))
        .filter((row) => !["schema_version", "usd_rub_rate", "jpy_rub_rate"].includes(asString(row[0])))
        .map((row) => [asString(row[0]), row[1]]);
      data.push(
        ["usd_rub_rate", rates.usdRub ? String(rates.usdRub) : ""],
        ["jpy_rub_rate", rates.jpyRub ? String(rates.jpyRub) : ""],
        ["schema_version", "3"],
      );
      updates.push({
        range: range(SHEETS.settings, `A1:B${data.length + 4}`),
        values: titledTableValues("Настройки поездки", SETTINGS_HEADERS, data),
      });
      migrated.add(SHEETS.settings);
    }

    if (!updates.length) return migrated;

    await this.client.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: updates },
    });

    if (migratedAccountCount) {
      const formulaUpdates = Array.from({ length: migratedAccountCount }, (_, index) => {
        const rowNumber = DATA_START_ROW + index;
        return {
          range: range(SHEETS.accounts, `E${rowNumber}`),
          values: [[accountBalanceFormula(rowNumber, separator)]],
        };
      });
      if (formulaUpdates.length) {
        await this.client.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: "USER_ENTERED", data: formulaUpdates },
        });
      }
    }

    return migrated;
  }

  private async writeTitledTable(
    spreadsheetId: string,
    sheetName: string,
    title: string,
    headers: string[],
  ): Promise<void> {
    await this.client.spreadsheets.values.update({
      spreadsheetId,
      range: range(sheetName, `A1:${columnLetter(headers.length)}4`),
      valueInputOption: "RAW",
      requestBody: { values: [[title], [], [], headers] },
    });
  }

  private async writeOverview(
    spreadsheetId: string,
    title: string,
    separator: string,
  ): Promise<void> {
    await this.client.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: {
        ranges: [
          range(SHEETS.overview, "A6:C13"),
          range(SHEETS.overview, `A16:C${GRID_ROW_COUNT}`),
          range(SHEETS.overview, `A32:G${GRID_ROW_COUNT}`),
        ],
      },
    });
    const values: unknown[][] = Array.from({ length: 31 }, () => []);
    values[0] = [title];
    values[3] = ["Остатки по счетам", "", "", "", "Итого расходов"];
    values[4] = ["Счёт", "Остаток", "Валюта", "", "Период", "Базовая", "RUB"];
    values[5] = [null, null, null, null, "Вся поездка"];
    values[13] = ["Расходы по категориям: базовая + RUB", "", "", "", "Сегодня"];
    values[14] = ["Категория", "Базовая", "RUB", "", "Период", "Базовая", "RUB"];
    values[15] = [null, null, null, null, "Сегодня"];
    values[29] = ["История операций"];
    values[30] = [
      "Наименование",
      "Категория",
      "Счёт",
      "Цена, ₽",
      "Цена, $",
      "Цена, ¥",
      "Дата",
    ];
    await this.client.spreadsheets.values.update({
      spreadsheetId,
      range: range(SHEETS.overview, "A1:G31"),
      valueInputOption: "RAW",
      requestBody: { values },
    });

    const baseCurrency =
      `IFERROR(INDEX('Настройки'!$B$5:$B${separator}` +
      `MATCH("base_currency"${separator}'Настройки'!$A$5:$A${separator}0))${separator}"RUB")`;
    const sumForPeriod = (dateFilter = "") =>
      `IF(${baseCurrency}="JPY"${separator}` +
      `SUMIFS('Траты'!$F$5:$F${separator}'Траты'!$K$5:$K${separator}"expense"${separator}'Траты'!$U$5:$U${separator}""${dateFilter})${separator}` +
      `IF(${baseCurrency}="USD"${separator}` +
      `SUMIFS('Траты'!$E$5:$E${separator}'Траты'!$K$5:$K${separator}"expense"${separator}'Траты'!$U$5:$U${separator}""${dateFilter})${separator}` +
      `SUMIFS('Траты'!$D$5:$D${separator}'Траты'!$K$5:$K${separator}"expense"${separator}'Траты'!$U$5:$U${separator}""${dateFilter})))`;
    const query = (baseColumn: "D" | "E" | "F", includeRub: boolean) =>
      `QUERY('Траты'!A5:U${separator}` +
      `"select B,sum(${baseColumn})${includeRub ? ",sum(D)" : ""} where K = 'expense' and U is null group by B label B '', sum(${baseColumn}) ''${includeRub ? ", sum(D) ''" : ""}"${separator}0)`;
    const formulas = [
      {
        range: range(SHEETS.overview, "A6"),
        values: [[
          `=IFERROR(QUERY('Счета'!A5:G${separator}"select A,E,C where G = true label A '', E '', C ''"${separator}0)${separator}"")`,
        ]],
      },
      {
        range: range(SHEETS.overview, "F6"),
        values: [[
          `=IFERROR(${sumForPeriod()}${separator}0)`,
        ]],
      },
      {
        range: range(SHEETS.overview, "G6"),
        values: [[
          `=IFERROR(SUMIFS('Траты'!$D$5:$D${separator}'Траты'!$K$5:$K${separator}"expense"${separator}'Траты'!$U$5:$U${separator}"")${separator}0)`,
        ]],
      },
      {
        range: range(SHEETS.overview, "A16"),
        values: [[
          `=IFERROR(IF(${baseCurrency}="JPY"${separator}${query("F", true)}${separator}` +
            `IF(${baseCurrency}="USD"${separator}${query("E", true)}${separator}${query("D", false)}))${separator}"")`,
        ]],
      },
      {
        range: range(SHEETS.overview, "F16"),
        values: [[
          `=IFERROR(${sumForPeriod(`${separator}'Траты'!$J$5:$J${separator}TODAY()`)}${separator}0)`,
        ]],
      },
      {
        range: range(SHEETS.overview, "G16"),
        values: [[
          `=IFERROR(SUMIFS('Траты'!$D$5:$D${separator}'Траты'!$K$5:$K${separator}"expense"${separator}'Траты'!$U$5:$U${separator}""${separator}'Траты'!$J$5:$J${separator}TODAY())${separator}0)`,
        ]],
      },
      {
        range: range(SHEETS.overview, "A32"),
        values: [[
          `=IFERROR(QUERY('Траты'!A5:U${separator}` +
            `"select A,B,C,D,E,F,J where L is not null and U is null order by M desc label A '', B '', C '', D '', E '', F '', J '' format J 'dd.MM.yyyy'"${separator}0)${separator}"")`,
        ]],
      },
    ];
    await this.client.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: formulas },
    });
  }

  private styleRequests(sheetName: string, sheetId: number): sheets_v4.Schema$Request[] {
    if (sheetName === SHEETS.overview) return this.overviewStyleRequests(sheetId);
    if (sheetName === SHEETS.transactions) return this.transactionStyleRequests(sheetId);
    if (sheetName === SHEETS.accounts) return this.accountStyleRequests(sheetId);
    if (sheetName === SHEETS.categories) return this.categoryStyleRequests(sheetId);
    return this.settingsStyleRequests(sheetId);
  }

  private transactionStyleRequests(sheetId: number): sheets_v4.Schema$Request[] {
    const requests = [
      ...titleAndHeaderStyle(sheetId, 10),
      showColumns(sheetId, 0, 10),
      dimensionWidth(sheetId, 0, 1, 300),
      dimensionWidth(sheetId, 1, 2, 155),
      dimensionWidth(sheetId, 2, 3, 165),
      dimensionWidth(sheetId, 3, 6, 118),
      dimensionWidth(sheetId, 6, 9, 112),
      dimensionWidth(sheetId, 9, 10, 108),
      hideColumns(sheetId, 10, 21),
      {
        setBasicFilter: {
          filter: { range: gridRange(sheetId, 3, GRID_ROW_COUNT, 0, 21) },
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 9, 10),
          cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd.mm.yyyy" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 3, 6),
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "NUMBER", pattern: "#,##0.00" },
              horizontalAlignment: "RIGHT",
            },
          },
          fields: "userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment",
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 6, 9),
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "NUMBER", pattern: "#,##0.0000" },
              horizontalAlignment: "RIGHT",
            },
          },
          fields: "userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment",
        },
      },
      {
        setDataValidation: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 1, 2),
          rule: {
            condition: {
              type: "ONE_OF_RANGE",
              values: [{ userEnteredValue: "='Категории'!$A$5:$A" }],
            },
            strict: false,
            showCustomUi: true,
          },
        },
      },
      {
        setDataValidation: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 2, 3),
          rule: {
            condition: {
              type: "ONE_OF_RANGE",
              values: [{ userEnteredValue: "='Счета'!$A$5:$A" }],
            },
            strict: false,
            showCustomUi: true,
          },
        },
      },
      conditionalTextColor(sheetId, 1, "Питание", COLORS.purple, COLORS.purpleText),
      conditionalTextColor(sheetId, 1, "Транспорт", COLORS.orange, COLORS.orangeText),
      conditionalTextColor(sheetId, 1, "Проживание", COLORS.green, COLORS.greenText),
      conditionalTextColor(sheetId, 1, "Развлечения", COLORS.blue, COLORS.blueText),
      conditionalTextColor(sheetId, 1, "Шопинг", COLORS.red, COLORS.redText),
      conditionalTextColor(sheetId, 1, "Пополнение", COLORS.green, COLORS.greenText),
      {
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [gridRange(sheetId, 4, GRID_ROW_COUNT, 0, 10)],
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: "=$U5<>\"\"" }],
              },
              format: {
                backgroundColor: rgb(COLORS.grey),
                textFormat: { foregroundColor: rgb(COLORS.greyText), strikethrough: true },
              },
            },
          },
        },
      },
      setSheetHidden(sheetId, true),
    ];
    return requests;
  }

  private accountStyleRequests(sheetId: number): sheets_v4.Schema$Request[] {
    return [
      ...titleAndHeaderStyle(sheetId, 7),
      showColumns(sheetId, 0, 7),
      dimensionWidth(sheetId, 0, 1, 230),
      dimensionWidth(sheetId, 1, 2, 125),
      dimensionWidth(sheetId, 2, 3, 90),
      dimensionWidth(sheetId, 3, 5, 145),
      dimensionWidth(sheetId, 5, 6, 125),
      dimensionWidth(sheetId, 6, 7, 90),
      hideColumns(sheetId, 7, 8),
      {
        setBasicFilter: {
          filter: { range: gridRange(sheetId, 3, GRID_ROW_COUNT, 0, 8) },
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 3, 5),
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 5, 6),
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.000000" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        setDataValidation: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 1, 2),
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: ["Карта", "Наличные", "Другое"].map((value) => ({ userEnteredValue: value })),
            },
            strict: true,
            showCustomUi: true,
          },
        },
      },
      {
        setDataValidation: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 6, 7),
          rule: { condition: { type: "BOOLEAN" }, strict: true, showCustomUi: true },
        },
      },
      conditionalTextColor(sheetId, 1, "Карта", COLORS.grey, COLORS.text),
      conditionalTextColor(sheetId, 1, "Наличные", COLORS.blue, COLORS.blueText),
      conditionalTextColor(sheetId, 1, "Другое", COLORS.primaryLight, COLORS.primary),
      {
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [gridRange(sheetId, 4, GRID_ROW_COUNT, 0, 7)],
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: "=$G5=FALSE" }],
              },
              format: { textFormat: { foregroundColor: rgb(COLORS.muted), strikethrough: true } },
            },
          },
        },
      },
      setSheetHidden(sheetId, true),
    ];
  }

  private categoryStyleRequests(sheetId: number): sheets_v4.Schema$Request[] {
    return [
      ...titleAndHeaderStyle(sheetId, 2),
      showColumns(sheetId, 0, 2),
      dimensionWidth(sheetId, 0, 1, 240),
      dimensionWidth(sheetId, 1, 2, 100),
      hideColumns(sheetId, 2, 3),
      {
        setBasicFilter: {
          filter: { range: gridRange(sheetId, 3, GRID_ROW_COUNT, 0, 3) },
        },
      },
      {
        setDataValidation: {
          range: gridRange(sheetId, 4, GRID_ROW_COUNT, 1, 2),
          rule: { condition: { type: "BOOLEAN" }, strict: true, showCustomUi: true },
        },
      },
      conditionalTextColor(sheetId, 0, "Питание", COLORS.purple, COLORS.purpleText),
      conditionalTextColor(sheetId, 0, "Транспорт", COLORS.orange, COLORS.orangeText),
      conditionalTextColor(sheetId, 0, "Проживание", COLORS.green, COLORS.greenText),
      conditionalTextColor(sheetId, 0, "Развлечения", COLORS.blue, COLORS.blueText),
      conditionalTextColor(sheetId, 0, "Шопинг", COLORS.red, COLORS.redText),
      setSheetHidden(sheetId, true),
    ];
  }

  private settingsStyleRequests(sheetId: number): sheets_v4.Schema$Request[] {
    return [
      ...titleAndHeaderStyle(sheetId, 2),
      showColumns(sheetId, 0, 2),
      dimensionWidth(sheetId, 0, 1, 210),
      dimensionWidth(sheetId, 1, 2, 360),
      setSheetHidden(sheetId, true),
    ];
  }

  private overviewStyleRequests(sheetId: number): sheets_v4.Schema$Request[] {
    const sectionRanges = [
      gridRange(sheetId, 3, 4, 0, 3),
      gridRange(sheetId, 3, 4, 4, 7),
      gridRange(sheetId, 13, 14, 0, 3),
      gridRange(sheetId, 13, 14, 4, 7),
      gridRange(sheetId, 29, 30, 0, 7),
    ];
    const headerRanges = [
      gridRange(sheetId, 4, 5, 0, 3),
      gridRange(sheetId, 4, 5, 4, 7),
      gridRange(sheetId, 14, 15, 0, 3),
      gridRange(sheetId, 14, 15, 4, 7),
      gridRange(sheetId, 30, 31, 0, 7),
    ];
    return [
      setSheetHidden(sheetId, false),
      showColumns(sheetId, 0, 7),
      {
        mergeCells: { range: gridRange(sheetId, 0, 2, 0, 7), mergeType: "MERGE_ALL" },
      },
      ...sectionRanges.map((sectionRange) => ({
        mergeCells: { range: sectionRange, mergeType: "MERGE_ALL" },
      })),
      {
        repeatCell: {
          range: gridRange(sheetId, 0, 2, 0, 7),
          cell: {
            userEnteredFormat: {
              backgroundColor: rgb(COLORS.primaryDark),
              verticalAlignment: "MIDDLE",
              textFormat: { foregroundColor: rgb(COLORS.white), fontSize: 18, bold: true },
            },
          },
          fields: "userEnteredFormat",
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 31, GRID_ROW_COUNT, 3, 6),
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 31, GRID_ROW_COUNT, 6, 7),
          cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd.mm.yyyy" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [gridRange(sheetId, 31, GRID_ROW_COUNT, 0, 7)],
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: "=ISEVEN(ROW())" }],
              },
              format: { backgroundColor: rgb(COLORS.stripe) },
            },
          },
        },
      },
      ...sectionRanges.map((sectionRange) => ({
        repeatCell: {
          range: sectionRange,
          cell: {
            userEnteredFormat: {
              backgroundColor: rgb(COLORS.primary),
              verticalAlignment: "MIDDLE",
              textFormat: { foregroundColor: rgb(COLORS.white), fontSize: 11, bold: true },
            },
          },
          fields: "userEnteredFormat",
        },
      })),
      ...headerRanges.map((headerRange) => ({
        repeatCell: {
          range: headerRange,
          cell: {
            userEnteredFormat: {
              backgroundColor: rgb(COLORS.primaryLight),
              textFormat: { foregroundColor: rgb(COLORS.primaryDark), bold: true },
            },
          },
          fields: "userEnteredFormat",
        },
      })),
      {
        repeatCell: {
          range: gridRange(sheetId, 5, GRID_ROW_COUNT, 1, 3),
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: gridRange(sheetId, 5, GRID_ROW_COUNT, 5, 7),
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      dimensionWidth(sheetId, 0, 1, 220),
      dimensionWidth(sheetId, 1, 3, 120),
      dimensionWidth(sheetId, 3, 4, 115),
      dimensionWidth(sheetId, 4, 5, 120),
      dimensionWidth(sheetId, 5, 7, 135),
      {
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: { frozenRowCount: 2, hideGridlines: true },
            tabColor: rgb(COLORS.primaryDark),
          },
          fields: "gridProperties.frozenRowCount,gridProperties.hideGridlines,tabColor",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 2 },
          properties: { pixelSize: 34 },
          fields: "pixelSize",
        },
      },
    ];
  }

  private async getSpreadsheetLocale(spreadsheetId: string): Promise<string> {
    const response = await this.client.spreadsheets.get({
      spreadsheetId,
      fields: "properties.locale",
    });
    return response.data.properties?.locale ?? "en_US";
  }

  private async getReferenceRates(
    spreadsheetId: string,
    existingSheets: Set<string | null | undefined>,
  ): Promise<ExchangeRates> {
    if (!existingSheets.has("Money")) return { usdRub: null, jpyRub: null };
    try {
      const rows = await this.getValues(spreadsheetId, range("Money", "A150:F300"));
      const headerIndex = rows.findIndex(
        (row) => asString(row[3]) === "USD/RUB" && asString(row[5]) === "JPY/RUB",
      );
      if (headerIndex < 0) return { usdRub: null, jpyRub: null };
      return {
        usdRub: positiveNumber(rows[headerIndex + 1]?.[3]),
        jpyRub: positiveNumber(rows[headerIndex + 2]?.[5]),
      };
    } catch {
      return { usdRub: null, jpyRub: null };
    }
  }

  private async getMoneyTable(spreadsheetId: string): Promise<MoneyTableInfo | null> {
    const response = await this.client.spreadsheets.get({
      spreadsheetId,
      fields:
        "sheets(properties(title,sheetId),tables(tableId,range,columnProperties(columnName)))",
    });
    const sheet = response.data.sheets?.find((item) => item.properties?.title === "Money");
    const sheetId = sheet?.properties?.sheetId;
    if (!sheet || typeof sheetId !== "number") return null;
    const expected = [
      "Наименование",
      "Тип",
      "Статус",
      "Вид оплаты",
      "Цена, ₽",
      "Цена, $",
      "Цена, ¥",
      "Курс USD/JPY",
      "Курс USD/RUB",
      "Дата транзакции",
      "Комментарий",
    ];
    const table = sheet.tables?.find((candidate) =>
      expected.every(
        (header, index) => candidate.columnProperties?.[index]?.columnName === header,
      ),
    );
    const tableRange = table?.range;
    if (
      !table?.tableId ||
      typeof tableRange?.startRowIndex !== "number" ||
      typeof tableRange.endRowIndex !== "number" ||
      typeof tableRange.startColumnIndex !== "number" ||
      typeof tableRange.endColumnIndex !== "number"
    ) {
      return null;
    }
    return {
      sheetId,
      tableId: table.tableId,
      startRowIndex: tableRange.startRowIndex,
      endRowIndex: tableRange.endRowIndex,
      startColumnIndex: tableRange.startColumnIndex,
      endColumnIndex: tableRange.endColumnIndex,
    };
  }

  private async findMoneyTransactionRow(
    spreadsheetId: string,
    table: MoneyTableInfo,
    transactionId: string,
  ): Promise<number | null> {
    const firstDataRowIndex = table.startRowIndex + 1;
    const response = await this.client.spreadsheets.get({
      spreadsheetId,
      ranges: [
        range("Money", `K${firstDataRowIndex + 1}:K${table.endRowIndex}`),
      ],
      includeGridData: true,
      fields: "sheets(data(rowData(values(note))))",
    });
    const rows = response.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const notePrefix = `Telegram ${transactionId} ·`;
    const offset = rows.findIndex((row) => row.values?.[0]?.note?.startsWith(notePrefix));
    return offset < 0 ? null : firstDataRowIndex + offset;
  }

  private async getValues(spreadsheetId: string, sheetRange: string): Promise<unknown[][]> {
    const response = await this.client.spreadsheets.values.get({
      spreadsheetId,
      range: sheetRange,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    return response.data.values ?? [];
  }
}

function rowNumberFromUpdatedRange(updatedRange: string | null | undefined): number {
  const match = updatedRange?.match(/![A-Z]+(\d+)/);
  if (!match?.[1]) throw new Error("Google Sheets не вернул номер добавленной строки.");
  return Number(match[1]);
}

function columnLetter(columnNumber: number): string {
  let value = columnNumber;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function titledTableValues(
  title: string,
  headers: string[],
  data: unknown[][],
): unknown[][] {
  const blankRow = () => Array.from({ length: headers.length }, () => "");
  return [
    [title, ...Array.from({ length: headers.length - 1 }, () => "")],
    blankRow(),
    blankRow(),
    headers,
    ...data,
  ];
}
