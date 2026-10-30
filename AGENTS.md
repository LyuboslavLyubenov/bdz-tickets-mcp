# AGENTS.md

Instructions for coding agents working in this repo. Read this before making changes.
Deep documentation: README.md (user docs) and PLAN.md (full reverse-engineered API reference).

## What this is

An MCP server for the BDZ e-ticket platform (bileti.bdz.bg). Bun + TypeScript, no framework.
It talks to the JSON API at `tickets.bdz.bg/portal` with bearer auth; there is no browser
automation anywhere. Eleven registered tools cover station lookup, route search, live seat
maps, price quotes, pending-ticket creation, payment links, payment status, ticket history,
and PDF download.

## Hard rules

- Never commit `.env`, tokens, or credentials. `.env` holds `BDZ_USERNAME` / `BDZ_PASSWORD`
  and is gitignored. Never print credential values in commands or logs.
- Never pay. The agent side of a purchase ends at the gateway payment link. Card entry
  happens in the user's browser on BORICA/ePay. Do not ask for card numbers.
- `bdz_create_ticket` and `bdz_payment_link` refuse to run without `confirm: true`. Before
  calling them, show the user the exact route, date, passengers, seat, and total price, and
  get explicit approval. A reservation left unpaid expires in ~10 minutes with no charge.
- Test scripts that create reservations (`scripts/verify-m3.ts`) need the user's OK first.
- Work on `main`. This repo has two remotes: `origin` (Gitea) and `github` (GitHub mirror).
  Push both.
- Keep the MCP server name and tool names (`bdz_*`) stable; they are a registered surface
  in users' client configs.

## Commands

| Task | Command |
|---|---|
| Install / register in clients | `bun scripts/setup.ts` |
| All tests (offline) | `bun test` |
| Typecheck | `bun run typecheck` |
| Live read-only smoke | `bun scripts/verify-live.ts --seats` |
| One tool call via MCP client | `bun scripts/mcp-call.ts <tool> '<json>'` |
| List tools via MCP client | `bun scripts/mcp-call.ts` |
| Purchase guard smoke (offline, no network) | `BDZ_DRY_RUN=1 bun scripts/verify-dry-run.ts` |
| Full gated purchase flow (asks first) | `bun scripts/verify-m3.ts [--pdf]` |
| Gateway shape check, creates one reservation (asks first) | `bun scripts/verify-payment-shape.ts` |

## Purchase flow rules (2026-10-26 lessons)

A real booking failed end to end that day: the outbound reservation was silently released,
every quoted round-trip price was unbookable, and the user never received a usable payment
link before the window closed. Rules that prevent a repeat:

- One leg at a time: reserve a leg, send the payment link, see it paid, then reserve the next.
  BDZ holds one pending purchase per account; a second create releases the first.
- Totals come from `bdz_quote` only, never from adding one-way prices. The ~30% return
  discount applies only inside ONE combined booking; per-leg bookings cost more.
- Quotes do not check availability. Use `bdz_quote` with `check_availability: true` (pass the
  train `stations` strings) before presenting a price as bookable.
- Use `provider: "auto"` in `bdz_payment_link`. ePay returns a plain URL; BORICA never does,
  so the server hosts the signed form as a local `127.0.0.1` page. Either way the user gets
  one clickable link. Never write HTML files to disk, and send the link in the same reply
  that generated it.
- After any payment failure, check `bdz_tickets` before explaining anything. `rc: -24` on
  `bdz_check_payment` means the window expired unpaid; it is not a card decline.

## Layout

```
src/api/       client.ts (fetch + 401 retry + test fetch shim), auth.ts (token cache),
               endpoints.ts (typed calls), payserver.ts (local form-POST pages), errors.ts
src/domain/    purchase.ts (pure builders + create/quote decisions), payform.ts (gateway HTML),
               paystatus.ts (CheckPayment interpretation), nomenclatures-cache.ts,
               session.ts (deadline + pending purchase state)
src/tools/     one module per tool group; zod schemas in shapes.ts
scripts/       setup.ts (installer), verify-live.ts, verify-m3.ts, verify-dry-run.ts,
               verify-payment-shape.ts, mcp-call.ts, lib/configs.ts
tests/         offline unit tests; fixtures are inline, captured from the live site
               (tests/replay-oct26.test.ts replays the real failed booking)
```

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. Run `bun run typecheck` after changes.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions`).
- Payload builders stay pure and live in `src/domain/`; every new builder gets unit tests
  against the real payload shapes documented in PLAN.md.
- New BDZ call? Add a typed wrapper in `src/api/endpoints.ts`, never raw fetch in tools.
- Tools return JSON via `jsonResult` and map errors through `handle()` so users see plain
  language, not stack traces. Never echo bearer tokens in errors.
- Requests send `Accept-Language: bg-BG`. Bulgarian strings from the API pass through
  verbatim; tool output keys are English.

## BDZ platform facts (quick map; full reference in PLAN.md)

- Base URL `https://tickets.bdz.bg/portal/`; login is `POST /Token` with
  `grant_type=password`. Token lives 24h, cached at `~/.config/bdz-tickets/token.json`.
- `route_id` from search is session-scoped. Never reuse across days; re-search instead.
- Payment session lasts 10 minutes. `src/domain/session.ts` tracks the deadline; the server
  keeps pending-purchase state in memory, so verify scripts must use one client connection.
- Seat types: 23 seated-1st, 25 seated-2nd, 10 sleeper-1st, 13 sleeper-2nd, 16 sleeper-business.
  Ticket class follows: 25 and 13 mean second class, everything else first.
- Passenger payload: `type_id` is the discount card id as a string ("-1" = none),
  `discount` is the card number, `birth_date` format is `DD/M/YYYY`.
- Caps per session: 5 seated, 3 sleeper-2nd, 2 sleeper-1st, 1 business.
- `api/schema/blockseat` and `api/schema/ReleaseSeat` exist server-side but are dead code in
  the current bundle. Do not build on them; seats are assigned through `GetTicket`.
- BORICA answers with a form POST (`pay_url` + `form_fields`), ePay usually with a redirect
  URL. The gateway path has no slash: `api/Payment/GetBoricaRequest?transactionId=N`.
- BDZ allows exactly ONE pending purchase per account. A second `GetTicket` (onlyPrice=false)
  silently releases the previous reservation; the server's supersede guard exists for this.
- Quotes (`GetTicket?onlyPrice=true`) do not validate seat availability: they price sold-out
  combinations. `first_class` / `sleeper_available` in search results mean the train carries
  such coaches, not that berths are free.
- `Payment/CheckPayment` `rc: -24` with no approval and no card data means the payment window
  expired unpaid. Ticket status 15 ("Отказано плащане от оператор") is the same situation, not
  a card decline. A paid round trip exists (2026-10-06), so online payment works for the user.
- Account-management endpoints (password, phone, birthdate, gender) are mapped in PLAN.md
  but deliberately not built. Do not add tools for them.

## Verification ladder

1. `bun test`: offline, always passes without network.
2. `bun run typecheck`: after any TS change.
3. `bun scripts/verify-live.ts --seats`: live but read-only; safe any time.
4. `bun scripts/verify-m3.ts`: creates a real pending ticket and opens a real BORICA
   transaction, then stops without paying. Ask the user before running. Do not run it in
   loops; BDZ sees each run as a real reservation.

## Install procedure (for agents setting the repo up on a new machine)

Run `bun scripts/setup.ts`. It installs dependencies, creates `.env` from the template, and
registers the server in every detected client (ZCode, opencode, Codex, Claude). Idempotent.
Flags: `--client zcode|opencode|codex|claude` (repeatable), `--email ... --password ...`,
`--no-verify`. If `.env` was just created, ask the user for their bileti.bdz.bg credentials
and write them to `.env` without printing them. Verify with `bun scripts/mcp-call.ts` (must
print 11 tools), then tell the user to restart their client(s).

## Commits and releases

- Commit style: `type: summary`, lowercase, imperative (e.g. `feat: one-prompt installer...`).
- Push both remotes: `git push origin main && git push github main`.
- Prose files (README, PLAN, this file) follow the stop-slop / humanizer rules: no em dashes,
  no decorative bold, no staged openers, plain statements. Code blocks and API data keep
  their exact formatting.
