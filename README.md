# bdz-tickets MCP server

An MCP server for the Bulgarian State Railways (БДЖ) e-ticketing platform
[bileti.bdz.bg](https://bileti.bdz.bg) — search routes, check live seat availability, quote prices,
create a pending ticket reservation, get a payment link, and download issued tickets as PDFs.

**The agent never pays.** Card entry always happens in your browser on the BORICA/ePay gateway.
Pending (unpaid) tickets auto-expire after ~10 minutes with no charge.

## Setup

```bash
bun install
cp .env.example .env        # then fill in your bileti.bdz.bg email + password
bun test                    # offline unit tests
bun scripts/verify-live.ts --seats   # live read-only smoke (login, search, seat map, quote)
```

## Tools

| Tool | What it does |
|---|---|
| `bdz_stations` | search the 697 BDZ stations by name fragment |
| `bdz_catalog` | seat/reservation types, classes, discount cards, add-ons |
| `bdz_refresh_cache` | drop the cached catalog |
| `bdz_search_routes` | trains between two stations for a date (+ optional return) |
| `bdz_seat_map` | live per-coach free/taken seats for one train |
| `bdz_quote` | exact total price, creates nothing |
| `bdz_create_ticket` | **gated** — creates the pending reservation (10-min window) |
| `bdz_payment_link` | **gated** — returns the BORICA/ePay payment URL for the user to open |
| `bdz_check_payment` | payment status of a transaction |
| `bdz_tickets` | ticket history (issued / cancelled / pending) |
| `bdz_ticket_pdf` | download a paid ticket as PDF |

The two money-adjacent tools require `confirm: true`; both the MCP schema and the handlers refuse
otherwise. `bdz_create_ticket` reserves a real seat — the calling model must show you the
route/passengers/price first and get your approval.

## Typical purchase flow

1. `bdz_stations` → ids · 2. `bdz_search_routes` → pick option (route_id/train_id) ·
3. `bdz_seat_map` (optional — specific seat) · 4. `bdz_quote` → confirm with user ·
5. `bdz_create_ticket` `confirm:true` → pending ticket · 6. `bdz_payment_link` `confirm:true` →
gateway URL/form fields (user pays in browser) · 7. `bdz_check_payment` / `bdz_tickets` →
`bdz_ticket_pdf`.

BORICA answers with a **form POST** payload (`pay_url` + `form_fields`): write a tiny
auto-submitting HTML page and open it. ePay typically answers with a plain redirect URL.

## Notes & constraints

- `route_id` values are session-scoped — re-search before buying on a later day.
- BDZ payment sessions last ~10 minutes; the server tracks the deadline and refuses stale payments.
- Max 5 seated / 3 sleeper-2nd / 2 sleeper-1st / 1 business tickets per session.
- Bearer tokens are cached at `~/.config/bdz-tickets/token.json` (chmod 600) and refreshed on 401.
- Credentials live in `.env` (gitignored). Never commit it; rotate if exposed.

## Verification scripts

```bash
bun scripts/mcp-call.ts                 # list tools through a real MCP client
bun scripts/mcp-call.ts bdz_stations '{"query":"плов"}'
bun scripts/verify-live.ts --seats      # read-only live smoke
bun scripts/verify-m3.ts --pdf          # gated purchase flow — creates one pending ticket, NEVER pays
```

`verify-m3.ts` leaves an unpaid pending ticket that expires by itself (observed: BDZ cancels it as
"Отказано плащане от оператор", seat freed, no charge). Do not run it more often than needed.

## Layout

`src/api/` HTTP+auth · `src/domain/` payload builders & session state · `src/tools/` MCP tools ·
`tests/` offline unit tests · `PLAN.md` full reverse-engineered API reference and design.
