const CURRENCY_ALIASES: Record<string, string> = {
  "$": "USD",
  "доллар": "USD",
  "доллары": "USD",
  "долларов": "USD",
  "€": "EUR",
  "евро": "EUR",
  "₽": "RUB",
  "рубль": "RUB",
  "рубли": "RUB",
  "рублей": "RUB",
  "¥": "JPY",
  "иена": "JPY",
  "иены": "JPY",
  "тенге": "KZT",
  "₸": "KZT",
  "бат": "THB",
  "баты": "THB",
  "฿": "THB",
  "дирхам": "AED",
  "дирхамы": "AED",
  "фунт": "GBP",
  "фунты": "GBP",
  "£": "GBP",
  "юань": "CNY",
  "юани": "CNY",
  "元": "CNY",
  "вона": "KRW",
  "₩": "KRW",
  "лира": "TRY",
  "₺": "TRY",
};

const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export function normalizeCurrencyCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase("ru-RU");
  const code = CURRENCY_ALIASES[normalized] ?? normalized.toUpperCase();
  return /^[A-Z]{3}$/.test(code) && SUPPORTED_CURRENCIES.has(code) ? code : null;
}
