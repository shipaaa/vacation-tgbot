import fs from "node:fs/promises";
import { google } from "googleapis";
import type { AppConfig } from "../config.js";

export type GoogleAuthClient = InstanceType<typeof google.auth.GoogleAuth>;

interface ServiceAccountCredentials {
  type?: string;
  client_email?: string;
  private_key?: string;
  project_id?: string;
}

export interface GoogleAuthResult {
  auth: GoogleAuthClient;
  serviceAccountEmail?: string;
}

export async function createGoogleAuth(config: AppConfig): Promise<GoogleAuthResult> {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];

  if (config.googleServiceAccountJson) {
    const credentials = parseServiceAccountCredentials(
      config.googleServiceAccountJson,
      "GOOGLE_SERVICE_ACCOUNT_JSON",
    );
    return {
      auth: new google.auth.GoogleAuth({ credentials, scopes }),
      serviceAccountEmail: credentials.client_email,
    };
  }

  const keyFile = config.googleCredentialsPath;
  if (!keyFile) throw new Error("Не найден путь к Google credentials");
  const credentials = parseServiceAccountCredentials(
    await fs.readFile(keyFile, "utf8"),
    keyFile,
  );

  return {
    auth: new google.auth.GoogleAuth({ keyFile, scopes }),
    serviceAccountEmail: credentials.client_email,
  };
}

function parseServiceAccountCredentials(
  input: string,
  source: string,
): ServiceAccountCredentials {
  let credentials: ServiceAccountCredentials;
  try {
    credentials = JSON.parse(input) as ServiceAccountCredentials;
  } catch {
    throw new Error(`Google credentials в ${source} содержат некорректный JSON.`);
  }

  if (
    credentials.type !== "service_account" ||
    !credentials.client_email ||
    !credentials.private_key
  ) {
    throw new Error(
      `Google credentials в ${source} не являются JSON-ключом service account. ` +
        "OAuth client_secret для этого бота не подходит.",
    );
  }

  return credentials;
}
