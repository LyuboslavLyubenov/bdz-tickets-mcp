# bdz-tickets-mcp

An MCP server for the BDZ e-ticket site [bileti.bdz.bg](https://bileti.bdz.bg), the
Bulgarian State Railways booking platform. It searches trains, shows live seat
availability, quotes prices, creates reservations, and hands you the payment link.
You pay in your browser on the BORICA or ePay gateway; the server never sees card
data. A reservation you don't pay expires after about 10 minutes with no charge.

The server talks to the JSON API that the site's own JavaScript uses
(`tickets.bdz.bg/portal`), so there is no browser automation anywhere. Bearer-token
auth, plain fetch, Bun runtime. PLAN.md documents every endpoint, payload, and
constraint I could reverse from the site.

## Tools

| Tool | What it does |
|---|---|
| `bdz_stations` | searches the 697 BDZ stations by name fragment |
| `bdz_catalog` | seat types, classes, discount cards, add-ons |
| `bdz_refresh_cache` | drops the cached catalog |
| `bdz_search_routes` | trains between two stations for a date, optional return date |
| `bdz_seat_map` | per-coach free and taken seats for one train |
| `bdz_quote` | exact total price, creates nothing |
| `bdz_create_ticket` | creates the pending reservation, 10-minute window |
| `bdz_payment_link` | returns the BORICA or ePay payment handoff |
| `bdz_check_payment` | payment status of a transaction |
| `bdz_tickets` | ticket history, issued / cancelled / pending |
| `bdz_ticket_pdf` | downloads a paid ticket as PDF |

`bdz_create_ticket` and `bdz_payment_link` refuse to run without `confirm: true`.
The calling agent has to show you the route, passengers, and price first and get
your approval. That refusal works at two layers: the MCP schema rejects the missing
argument, and the handler rejects `confirm: false` with instructions.

## Setup

```
bun install
cp .env.example .env    # fill in your bileti.bdz.bg email + password
bun test                # offline unit tests
```

Register it with an MCP client. For ZCode, add to `~/.zcode/cli/config.json`:

```json
{
  "mcp": {
    "servers": {
      "bdz-tickets": {
        "command": "/absolute/path/to/bun",
        "args": ["/absolute/path/to/bdz-tickets/src/index.ts"]
      }
    }
  }
}
```

Any other MCP client that spawns stdio servers works the same way.

## Buying a ticket

1. `bdz_stations` for the station ids
2. `bdz_search_routes` and pick a train (you get `route_id` and `train_id`)
3. `bdz_seat_map` if you care about the specific seat
4. `bdz_quote`, then agree on the trip with the person paying
5. `bdz_create_ticket` with `confirm: true`. This reserves a real seat and starts
   BDZ's 10-minute payment session
6. `bdz_payment_link` with `confirm: true`. BORICA answers with a form POST
   (`pay_url` plus `form_fields`), so write a small auto-submitting HTML page and
   open it. ePay usually returns a plain redirect URL instead
7. `bdz_check_payment` or `bdz_tickets`, then `bdz_ticket_pdf`

## Behavior worth knowing

- `route_id` values change with every search. Search again before buying on another
  day, and again if the payment window lapses.
- BDZ caps a session at 5 seated, 3 sleeper second class, 2 sleeper first class, or
  1 business ticket.
- The bearer token is cached at `~/.config/bdz-tickets/token.json` with 600
  permissions and refreshed automatically on 401. Credentials live in `.env`, which
  git ignores. Rotate the password if it leaks.

## Verification scripts

```
bun scripts/mcp-call.ts                                   # list tools through a real MCP client
bun scripts/mcp-call.ts bdz_stations '{"query":"плов"}'    # one tool call
bun scripts/verify-live.ts --seats                        # read-only: login, search, seat map, quote
bun scripts/verify-m3.ts --pdf                            # full gated flow, never pays
```

`verify-m3.ts` creates one real pending reservation and opens a BORICA transaction,
then stops. BDZ cancels the unpaid reservation on its own; the observed status is
"Отказано плащане от оператор", the seat is freed, and nothing is charged. Don't run
it more often than you need to.

## Layout

`src/api/` holds the HTTP client, auth, and typed endpoints. `src/domain/` holds the
payload builders and purchase-session state. `src/tools/` holds the MCP tool
registrations. `tests/` runs offline against payloads captured from the live site.
PLAN.md is the full API reference and design doc.
