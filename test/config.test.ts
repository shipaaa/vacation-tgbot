import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

function stubRequiredEnv(): void {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/credentials.json");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "");
  vi.stubEnv("ALLOWED_TELEGRAM_USER_IDS", "");
  vi.stubEnv("ALLOW_PUBLIC_ACCESS", "false");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig access policy", () => {
  it("разрешает запуск с явным списком пользователей", () => {
    stubRequiredEnv();
    vi.stubEnv("ALLOWED_TELEGRAM_USER_IDS", "42, 100500");

    const config = loadConfig();

    expect(config.allowedTelegramUserIds).toEqual(new Set([42, 100500]));
    expect(config.allowPublicAccess).toBe(false);
  });

  it("закрывает запуск без allowlist по умолчанию", () => {
    stubRequiredEnv();

    expect(() => loadConfig()).toThrow(/ALLOW_PUBLIC_ACCESS=true/);
  });

  it("разрешает публичный режим только при явном opt-in", () => {
    stubRequiredEnv();
    vi.stubEnv("ALLOW_PUBLIC_ACCESS", "true");

    expect(loadConfig().allowPublicAccess).toBe(true);
  });

  it("не игнорирует ошибочные user ID", () => {
    stubRequiredEnv();
    vi.stubEnv("ALLOWED_TELEGRAM_USER_IDS", "42,not-an-id,-7");

    expect(() => loadConfig()).toThrow(/not-an-id, -7/);
  });
});
