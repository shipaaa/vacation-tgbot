# Travel Budget Telegram Bot

A Telegram-first travel expense tracker backed by Google Sheets. One chat can
connect multiple trip spreadsheets, switch between them, record expenses and
top-ups, monitor account balances, and keep a familiar spreadsheet budget up to
date without editing it from a phone.

The bot is designed for a Russian-speaking Telegram interface, while this README
documents the project for contributors.

## Features

- multiple Google Sheets trips per Telegram chat;
- one active trip with quick switching;
- cash, card, and custom accounts in different currencies;
- separate purchase price and actual account debit;
- RUB, USD, and JPY conversion with historical rates per transaction;
- configurable base currency and exchange rates;
- account balances and category summaries;
- today/all-trip summary in the trip currency and RUB;
- configurable home clock on the dashboard;
- a single editable Telegram control panel instead of a stream of bot messages;
- best-effort cleanup of processed user input in private chats;
- expense mirroring into an existing styled `Money` Google Table;
- atomic undo across the internal ledger and the visible `Money` table;
- Telegram user allowlist;
- Docker support.

## How It Works

```mermaid
flowchart LR
    User --> Telegram["Telegram / grammY"]
    Telegram --> Bot["Conversation UI"]
    Bot --> Service["TravelService"]
    Service --> Money["Currency and balance domain"]
    Service --> Sheets["Google Sheets Gateway"]
    Service --> State["Local JSON trip registry"]
    Sheets --> Google["Google Sheets"]
```

Google Sheets stores the financial data. The local JSON file only stores which
spreadsheets are connected to each Telegram chat and which trip is active.

## Requirements

- Node.js 20 or newer;
- a Telegram bot token from BotFather;
- a Google Cloud project with Google Sheets API enabled;
- a Google service account JSON key for local development;
- edit access for the service account on every connected spreadsheet.

OAuth Client ID files such as `client_secret_*.json` are not supported by the
current authentication flow.

## Quick Start

### 1. Install

```bash
npm ci
cp .env.example .env
```

### 2. Create the Telegram bot

1. Open `@BotFather`.
2. Run `/newbot`.
3. Put the returned token in `TELEGRAM_BOT_TOKEN`.
4. Add your numeric Telegram user ID to `ALLOWED_TELEGRAM_USER_IDS`.

Leaving the allowlist empty makes the bot available to anyone who finds its
username.

### 3. Configure Google

1. Create or select a Google Cloud project.
2. Enable Google Sheets API.
3. Create a service account.
4. Create a JSON key for local development.
5. Save it as `credentials.json` in the project directory, or point
   `GOOGLE_APPLICATION_CREDENTIALS` to another path.
6. Share each trip spreadsheet with the key's `client_email` as an Editor.

The service account does not need a broad project-level IAM role merely to edit
a spreadsheet shared with it.

### 4. Run

```bash
npm run dev
```

Open the bot and connect a spreadsheet:

```text
/connect https://docs.google.com/spreadsheets/d/.../edit
```

After that, use the inline control panel.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Token issued by BotFather. |
| `GOOGLE_APPLICATION_CREDENTIALS` | One of two | Path to a service account JSON key. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | One of two | Full service account JSON as one line. Useful in hosted environments. |
| `STATE_FILE` | No | Trip registry path. Defaults to `./data/state.json`. |
| `DEFAULT_TIMEZONE` | No | Default operation timezone for newly connected trips. |
| `ALLOWED_TELEGRAM_USER_IDS` | Recommended | Comma-separated numeric Telegram user IDs. |

Never commit `.env`, service account keys, `data/state.json`, or Telegram tokens.
The provided `.gitignore` excludes the standard local paths.

## Telegram UX

The bot maintains one editable dashboard message per in-memory session. It shows:

- the active trip;
- a configurable home clock;
- today's spend in the base currency and RUB;
- current account balances;
- action buttons for expenses, top-ups, accounts, summaries, trips, and settings.

In a private chat, processed text input is deleted on a best-effort basis. This
keeps the chat focused on the current panel. If Telegram refuses deletion, the
workflow continues normally.

Conversation state is currently in memory and resets when the process restarts.
Recorded transactions and connected-trip state remain intact.

## Bot Commands

Commands registered in the BotFather menu:

| Command | Purpose |
| --- | --- |
| `/start` | Open the dashboard. |
| `/expense` | Start a new expense. |
| `/income` | Top up an account. |
| `/accounts` | Show balances and add accounts. |
| `/summary` | Show the trip summary. |
| `/trips` | Manage connected trips. |
| `/help` | Show a short usage guide. |

Legacy shortcuts including `/connect`, `/undo`, `/cancel`, `/rates`, `/today`,
and `/skip` remain implemented but are intentionally omitted from the compact
BotFather menu.

## Google Sheets Contract

### Visible `Money` sheet

If the workbook contains a compatible Google Table on a sheet named `Money`,
every Telegram expense is appended to that table. The expected columns, in
order, are:

```text
Наименование | Тип | Статус | Вид оплаты | Цена, ₽ | Цена, $ | Цена, ¥ |
Курс USD/JPY | Курс USD/RUB | Дата транзакции | Комментарий
```

The user-entered expense title is written to `Наименование`. If the title is
skipped, the selected category is used. The category is written to `Тип`.

The gateway inserts a physical row at the end of the Google Table and expands
its range. This preserves the workbook's formatting and moves summaries and rate
blocks below the table without overwriting them.

Top-ups are not mirrored to `Money`, because it represents spending rather than
all account movements.

The original `Overview` sheet is treated as itinerary data and is never modified.

### Internal sheets

The bot creates and hides these sheets:

| Sheet | Purpose |
| --- | --- |
| `Траты` | Full append-only ledger for expenses and top-ups. |
| `Счета` | Accounts, opening balances, current balances, and RUB rates. |
| `Категории` | Editable category dictionary and ordering. |
| `Настройки` | Per-trip settings and schema versions. |
| `Обзор` | Formula-based fallback dashboard for workbooks without compatible `Money`. |

Undo marks the internal ledger row as deleted. For expenses, it also finds the
visible `Money` row by a hidden cell note containing `tx_id`, removes that row,
and shrinks the Google Table in the same Sheets batch update.

## Per-Trip Settings

| Key | Purpose |
| --- | --- |
| `trip_name` | Trip title. |
| `timezone` | Operation date and "today" timezone. |
| `home_timezone` | Reference clock shown on the Telegram dashboard. Defaults to `Europe/Moscow`. |
| `base_currency` | Country/trip currency used in summaries. |
| `usd_rub_rate` | RUB value of 1 USD for future transactions. |
| `jpy_rub_rate` | RUB value of 1 JPY for future transactions. |
| `schema_version` | Internal data schema version. |
| `layout_version` | Internal sheet layout version. |

`timezone` and `home_timezone` are intentionally separate: one controls
transaction dates, while the other is only a reference clock.

## Currency Model

Each transaction keeps both:

- purchase amount and currency;
- actual account movement and account currency.

It also stores calculated RUB, USD, and JPY values plus USD/JPY, USD/RUB, and
JPY/RUB rates. Existing transactions retain their historical rates when trip
settings change.

Balances use the actual account movement:

```text
opening balance + active top-ups - active expenses
```

## Multiple Trips

Connected spreadsheets are stored per Telegram chat in `data/state.json`. A chat
can connect multiple spreadsheets and select one active trip. Disconnecting a
trip only removes the local connection; it does not delete or alter the Google
spreadsheet.

The state file uses atomic temp-file replacement and serializes writes in a
queue. Mount it on persistent storage when deploying.

## Development

```bash
# Type-check
npm run check

# Test
npm test

# Build
npm run build

# Run compiled output
npm start
```

Prepare or migrate one spreadsheet without using Telegram:

```bash
npm run setup-sheet -- "https://docs.google.com/spreadsheets/d/.../edit"
```

Only one long-polling process may use a Telegram token at a time. Running a
second instance produces a `getUpdates` conflict.

## Tests

The current test suite covers:

- amount parsing;
- currency conversion;
- account balances;
- category summaries;
- spreadsheet ID extraction;
- JSON state persistence and legacy migration.

Google Sheets and Telegram flows still require integration or manual testing,
especially after changes to `sheetsGateway.ts` or callback state transitions.

## Docker

```bash
docker build -t travel-sheets-bot .
docker run --rm \
  --env-file .env \
  -v "$PWD/credentials.json:/app/credentials.json:ro" \
  -v "$PWD/data:/app/data" \
  travel-sheets-bot
```

For hosted deployments, prefer a secret manager and
`GOOGLE_SERVICE_ACCOUNT_JSON` instead of baking a key into the image.

## Security Checklist

Before pushing:

```bash
git status --short
git check-ignore -v .env credentials.json data/state.json
git grep -nE '(-----BEGIN PRIVATE KEY-----|[0-9]{8,12}:AA[A-Za-z0-9_-]{30,})' -- . ':!package-lock.json'
```

Also verify that no personal chat IDs, spreadsheet IDs, screenshots, or exported
workbooks have been staged accidentally.

## Current Limitations

- conversation state is in memory;
- connected trips are stored in a local JSON file rather than a database;
- only one long-polling instance is supported;
- transfers and currency exchanges are modeled as separate expense/top-up steps;
- arbitrary historical transaction editing is not implemented;
- receipt OCR is not implemented;
- failed `Money` mirroring has no durable retry queue;
- the visible `Money` integration currently targets a RUB/USD/JPY workbook
  structure.

## Maintainer Notes

Detailed architecture, invariants, troubleshooting, and change-safety notes are
available in Russian: [docs/PROJECT_RU.md](docs/PROJECT_RU.md).
