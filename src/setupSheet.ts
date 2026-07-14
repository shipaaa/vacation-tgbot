import "dotenv/config";
import { loadConfig } from "./config.js";
import { createGoogleAuth } from "./google/auth.js";
import { GoogleSheetsGateway } from "./google/sheetsGateway.js";
import { extractSpreadsheetId } from "./services/travelService.js";

const input = process.argv[2]?.trim();
const spreadsheetId = input ? extractSpreadsheetId(input) : null;
if (!spreadsheetId) {
  throw new Error("Передай ссылку или ID Google-таблицы первым аргументом.");
}

const config = loadConfig();
const { auth, serviceAccountEmail } = await createGoogleAuth(config);
const gateway = new GoogleSheetsGateway(auth);
const title = await gateway.initializeSpreadsheet(
  spreadsheetId,
  config.defaultTimezone,
);

console.log(`Таблица «${title}» подготовлена для ${serviceAccountEmail ?? "service account"}.`);
