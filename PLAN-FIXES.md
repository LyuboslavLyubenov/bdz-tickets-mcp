# PLAN-FIXES.md

Hardening plan for the purchase flow, written after the failed booking session of 2026-10-26
(Burgas to Sofia round trip, sleeper 2nd class). That session reserved two sleeper berths and
still ended with no tickets: the payment link was never usable, the first reservation was
silently released, and every price shown to the user was wrong or unbookable. This file lists
each failure, the code fix that prevents it, and the tests that prove the fix works.

All fixes keep the registered tool names stable (`bdz_*`). No new tools; behavior and output
fields change instead.

## 1. What actually went wrong, mapped to code

| # | Failure in the session | Root cause in the repo |
|---|---|---|
| 1 | User never received a clickable payment link. BORICA returns a bare gateway URL plus signed form fields; the tool note says "write a tiny auto-submitting HTML page". The user rejected the file, the 10-minute window burned in the argument, the transaction died unpaid (BORICA rc=-24, no card data). | `src/tools/purchase-write.ts` payment branch returns `pay_url` + `form_fields` and delegates delivery to the agent. Same failure mode likely caused the Sofia-Plovdiv "Отказано плащане от оператор" ticket of 2026-10-11. |
| 2 | Second `bdz_create_ticket` (return leg) silently released the first reservation (outbound ticket 67815925). | `src/domain/session.ts` `setPendingPurchase()` overwrites the single slot. Comment says "one slot is enough"; BDZ allows one pending purchase per account, so a second create is destructive, not a new record. |
| 3 | Combined two-leg create rejected with "Няма достатъчно спални места от поисканата класа" while both per-leg seat maps showed free berths. | Error is mapped through generic `handle()`; the agent got a raw message and kept going as if nothing structural happened. |
| 4 | Round-trip quotes (36.16, 33.60, 27.87) were shown as bookable options. One combo referenced a sold-out leg; the combined booking behind the discounted price was refused; real cost became 2 x 20.20. | `bdz_quote` never checks availability; nothing in its output says the price is theoretical. |
| 5 | Seat map errors ("Няма намерени свободни места!", HTTP 400) were reported as "sold out" without distinguishing API error from sold-out state. | No error mapping for this string in `src/api/errors.ts`. |
| 6 | Agent-side process errors: naive per-leg price math, quoting unavailable combos, delivering the link late, choosing BORICA without considering ePay. | Tool descriptions and AGENTS.md do not state the rules: quote totals only, one leg at a time, send the link immediately, prefer ePay for a direct link. |
| 7 | After payment failure there was no interpretation: `bdz_check_payment` returns raw BORICA fields (`action: 3, rc: -24`) with a generic hint. | `checkPayment` result passed through uninterpreted; rc=-24 means expired/unpaid, not a card decline. My first post-mortem got this wrong and blamed the card. |

## 2. Fixes

### F1. Pending purchase guard (fixes failure 2)

`src/domain/session.ts`:

- Replace the silent overwrite. New `beginPendingPurchase(p)` returns `{ superseded }` when a
  live (non-expired) pending purchase already exists, including its ticket ids and price.
- `src/tools/purchase-write.ts` create tool: when `superseded` is set, refuse unless the input
  carries `supersede: true` (new optional boolean in the schema). The refusal message states
  that BDZ releases the previous reservation, that a combined round-trip discount would be
  lost by booking legs separately, and tells the agent to re-confirm the price with the user.
- Decision logic goes into a pure function `decideCreate(existing, args)` in
  `src/domain/purchase.ts` so it is testable offline.

### F2. The payment link must be a real link (fixes failure 1)

- Add `auto` to the provider enum in `bdz_payment_link` and make it the documented default for
  agents: try ePay first. ePay answers with shape (a) `{status: 301, url}` (PLAN.md 3.7), a
  directly openable URL. Fall back to BORICA only if ePay fails, with an explicit warning.
- For BORICA (shape b, `formFields`): stop telling the agent to write files. The server hosts
  the form itself. New `src/domain/payform.ts` builds the auto-submit HTML (pure function);
  new `src/api/payserver.ts` starts a localhost listener on 127.0.0.1 with a random port and
  serves it per transaction id. The tool then returns `pay_url` as
  `http://127.0.0.1:PORT/pay/<transactionId>` with `direct_link: true`. One link, opens in a
  browser, POSTs the signed fields to BORICA, done. Listener shuts down when the payment
  window expires or payment completes.
- Output schema additions for both shapes: `direct_link: boolean`,
  `payment_deadline_iso: string`, `tickets_covered: number[]`, and on the BORICA fallback path
  a `warning` naming the limitation in one line.
- Tool description change: "Send pay_url to the user in your first reply after this call.
  Never write files to disk."

### F3. Coverage check before the gateway call (fixes failure 2 detection)

In `bdz_payment_link` (session purchases only, not external `transaction_id`): after
`createPaymentTransaction`, call `GetUserTickets` and verify every expected pending ticket id
is still in status 11. If any is missing, refuse with: which ticket vanished, why (BDZ holds
one pending purchase; a newer create replaced it), and the recovery path (re-search, re-create
one leg, pay, then the next leg). Costs one extra read on the money path; that is the right
trade.

### F4. Honest quotes (fixes failure 4)

`bdz_quote` gains optional `check_availability: boolean`. When true, the tool fetches the seat
map for each leg and seat type and annotates the result:

```
per leg: { free_seats: n, available: boolean }
top level: { bookable: boolean, price_is_theoretical: boolean }
```

Pure helper `annotateQuote(quote, seatMaps)` in `src/domain/purchase.ts`, offline-testable.
Tool description gains: "Quote prices are theoretical unless check_availability confirms every
leg. BDZ applies the ~30% return discount only inside one combined booking; two one-way
bookings cost more. Totals must come from this tool, never from adding one-way prices."

### F5. Error and status mapping (fixes failures 3, 5, 7)

`src/api/errors.ts` mapping table for exact upstream strings:

| Upstream text | Code | Meaning returned to the agent |
|---|---|---|
| `Няма намерени свободни места!` | `no_free_seats` | Sold out for this class and date. Not a malfunction. Re-check other classes or dates. |
| `Няма достатъчно спални места от поисканата класа` | `combined_unavailable` | The combined booking was refused despite per-leg seat maps showing free berths. Book legs one at a time; the return discount is lost; re-quote and re-confirm the price with the user. |

New `src/domain/paystatus.ts`: interprets CheckPayment responses. `rc: -24` with no approval
and no card data maps to `expired_unpaid` ("the payment window passed with nothing charged;
not a card decline"). `rc: 0` with approval maps to `paid`. Unknown codes pass through with
the raw payload. `bdz_tickets` status 15 changes from "other" to
`payment_not_completed` in the tool output.

### F6. Rules in tool descriptions and AGENTS.md (fixes failure 6)

AGENTS.md gains a "Purchase flow rules" block: one leg reserved and fully paid before the
next is created; totals only from `bdz_quote`; the payment link goes to the user in the same
reply that generated it; prefer ePay for a clickable link; after any real payment failure,
verify ticket status with `bdz_tickets` before telling the user what happened.

### F7. Dry-run mode (test enablement)

With `BDZ_DRY_RUN=1`, `bdz_create_ticket` and `bdz_payment_link` run all guard logic
(pending-purchase check, coverage check, provider selection, page building) and return the
payloads they would have sent, marked `dry_run: true`, without touching BDZ. This makes the
whole guidance layer testable end to end with no reservations created.

## 3. Tests

The session gave us a full recorded trace of a failed purchase: searches, seat maps, quotes,
create results, the gateway payload, and the final status. That trace becomes a replay
fixture, and the bar for "fixed" is: replaying it through the new code produces a warning or
refusal at every step where the session went wrong.

### T1. Offline unit tests (extend `bun test`)

- `tests/session.test.ts`: `beginPendingPurchase` supersede detection, expiry behavior,
  supersede flag on decision function.
- `tests/purchase.test.ts`: `decideCreate` (refuse without `supersede`, warn with it),
  `annotateQuote` (unavailable leg forces `bookable: false`), `buildPayFormPage` (HTML
  contains the action URL, every field, auto-submit), `paystatus` interpretation
  (rc=-24 to `expired_unpaid`, rc=0 to `paid`).
- `tests/errors.test.ts` (new): the two upstream strings map to the documented codes;
  unknown strings stay unmapped.

### T2. Fetch shim and mocked integration (new)

`src/api/client.ts` gains an injectable fetch (test-only). New
`tests/scenario-oct26.test.ts` runs the corrected flow offline against recorded responses:

search, seat maps, quote with `check_availability` (assert `bookable: false` on the
sold-out combo), combined create (assert `combined_unavailable` guidance), per-leg creates
(assert supersede refusal on the second create without the flag), payment link via `auto`
(assert ePay shape returns a direct URL; assert BORICA shape returns a localhost URL served
by the pay form server, and that a GET on it returns working HTML), coverage check (assert
refusal when a pending ticket disappears from status 11).

### T3. Replay regression (new, the "would have caught it" gate)

`tests/replay-oct26.test.ts`: fixtures are the exact payloads from the 2026-10-26 session
(search results for 28-29.10, seat maps with 2 and 3 berths, the five quotes, the combined
create error body, both create results, the BORICA form payload, CheckPayment rc=-24, the
tickets page with status 15). One assertion per failure row in section 1: replaying produces
a refusal, a `bookable: false`, a `direct_link`, or an `expired_unpaid` label where the
original run produced silence or wrong numbers. This test fails if anyone removes a guard.

### T4. Dry-run smoke (new)

`scripts/verify-dry-run.ts` (offline, safe, no gating): sets `BDZ_DRY_RUN=1`, drives
`bdz_create_ticket` and `bdz_payment_link` end to end through the MCP client
(`scripts/mcp-call.ts`), asserts `dry_run: true` outputs contain the guard results and a
`pay_url` in both provider shapes. Runs in CI-style local checks without network.

### T5. Live verification ladder (additions; existing ladder unchanged)

New `scripts/verify-payment-shape.ts`, gated behind explicit user approval like
`verify-m3.ts` (it creates one real pending reservation):

1. Create one pending ticket on a cheap route (Sofia-Plovdiv).
2. Call the gateway with ePay; assert shape (a) `{status: 301, url}` and print the URL.
3. Repeat with BORICA; assert the localhost pay page serves and contains the signed fields.
4. Never pay. Let the reservation expire. Print ticket status before and after.

### T6. Acceptance checklist before the next real booking

- `bun test` green including T1-T4; `bun run typecheck` clean.
- Replay test (T3) passes: every section-1 failure row is caught by a guard.
- `verify-payment-shape.ts` run once with user approval: ePay link observed as a plain URL,
  BORICA localhost page observed working.
- AGENTS.md purchase flow rules merged; PLAN.md gains the new API facts
  (one pending purchase per account; rc=-24 semantics; quote does not check availability;
  `sleeper_available` means the coach exists, not that berths are free; ePay 301 shape).

## 4. Suggested order

1. F1, F5 (guards and mapping; smallest, highest value)
2. F2, F3 (payment link delivery and coverage check)
3. F4 (quote availability), F6 (docs)
4. T1-T3 with the replay fixtures captured first
5. F7 and T4, then T5 live run with user approval

## 5. Non-goals

No auto-payment, no card data handling, no account-management endpoints (declined), no new
tool names, no retry loops on purchase endpoints. Payment remains a user-driven browser step;
the server's job ends at a working link the user can open.
