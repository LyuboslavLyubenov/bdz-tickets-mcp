# bdz-tickets-mcp — notes for coding agents

An MCP server for the BDZ e-ticket platform (bileti.bdz.bg). Full docs: README.md and PLAN.md.

## Install (one prompt)

When a user asks to install or set up this repo, run:

```
bun scripts/setup.ts
```

That single command: installs dependencies, creates `.env` from the template, and registers
the `bdz-tickets` server in every detected client (ZCode `~/.zcode/cli/config.json`,
opencode `~/.config/opencode/opencode.json`, Codex `~/.codex/config.toml`,
Claude via `claude mcp add --scope user` or the Claude Desktop config).
It is idempotent, so re-running is safe. `bun run setup` does the same thing.

Then finish these two steps:

1. If `.env` was just created (no credentials yet), ask the user for their bileti.bdz.bg
   email and password and write them into `.env` as `BDZ_USERNAME` / `BDZ_PASSWORD`.
   Never print the values, never commit the file.
2. Verify with `bun scripts/mcp-call.ts` — it must print 11 tools.

Flags: `--client zcode|opencode|codex|claude` (repeatable, limits the install),
`--email ... --password ...` (write credentials non-interactively), `--no-verify`.

Tell the user to restart their client(s) so the new server connects. The tools then show
up as `bdz_stations`, `bdz_search_routes`, `bdz_seat_map`, `bdz_quote`, `bdz_create_ticket`,
`bdz_payment_link`, `bdz_check_payment`, `bdz_tickets`, `bdz_ticket_pdf`, `bdz_catalog`,
`bdz_refresh_cache`.

## Behavior rules for the purchase tools

`bdz_create_ticket` and `bdz_payment_link` refuse to run without `confirm: true`. Before
calling them you must show the user the exact route, date, passengers, seat, and total
price, and get their explicit approval. The user always completes card payment themselves
in their browser on the BORICA/ePay gateway; do not ask for card details. A reservation
left unpaid expires after ~10 minutes with no charge.

`route_id` values from `bdz_search_routes` are session-scoped. Search again rather than
reusing old ids. The server tracks the 10-minute deadline and refuses stale payments.

## Development

- `bun test` — offline unit tests (30)
- `bun run typecheck` — tsc
- `bun scripts/verify-live.ts --seats` — live read-only smoke (login, search, seat map, quote)
- `bun scripts/verify-m3.ts` — full gated purchase flow; creates one pending ticket and
  never pays. Ask the user before running it.
