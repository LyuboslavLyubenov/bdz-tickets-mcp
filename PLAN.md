# BDZ Tickets MCP Server — Detailed Plan

**Status:** approved (MCP, not skill) · **Created:** 2026-10-10 · **Project dir:** `~/Desktop/bdz-tickets`

An MCP server that lets an AI agent search BDZ (БДЖ) train routes, check live seat availability, quote prices, create a ticket reservation, hand the user a payment link, and fetch issued tickets as PDFs. The **card payment itself always happens in the user's browser** on the BORICA/ePay gateway — the agent never touches card data.

All API knowledge below was reverse-engineered from `bileti.bdz.bg`'s JS bundle on 2026-10-10 and **verified live** (login, search, seat map, quote, pending-ticket creation, payment handoff shape, ticket list, PDF download).

---

## 1. Architecture

| Choice | Decision | Why |
|---|---|---|
| Runtime | Bun + TypeScript | matches the rest of the user's tooling; native fetch; single-file run |
| MCP SDK | `@modelcontextprotocol/sdk`, stdio transport | standard, works in ZCode + any MCP client |
| Layout | standalone repo at `~/Desktop/bdz-tickets` (own git repo) | unrelated to `business-auditor`; AGENTS.md repo rules don't apply here |
| HTTP | plain `fetch`, no deps | API is simple JSON + bearer |
| Auth | `POST /Token` (`grant_type=password`) → bearer, cached on disk, auto-refresh on 401 | verified working from curl; 24h validity |
| Config | `.env` (gitignored): `BDZ_USERNAME`, `BDZ_PASSWORD` | credentials must not live in chat history or the repo |
| Language | requests send `Accept-Language: bg-BG` (site default); tool outputs use English keys with Bulgarian display strings verbatim | matches what the API returns |

### Directory sketch

```
bdz-tickets/
├── PLAN.md                  ← this file
├── package.json / bunfig.toml
├── .env.example             (BDZ_USERNAME=, BDZ_PASSWORD=)
├── src/
│   ├── index.ts             MCP server bootstrap + tool registration
│   ├── api/
│   │   ├── client.ts        fetch wrapper: base URL, bearer, 401→re-login→retry once, error normalization
│   │   ├── auth.ts          token endpoint + disk cache (~/.config/bdz-tickets/token.json, chmod 600)
│   │   └── endpoints.ts     typed functions, 1:1 with §3
│   ├── domain/
│   │   ├── nomenclatures.ts cached stations/seat-types/classes/discounts/addons
│   │   ├── purchase.ts      ticket-object builders (payloads in §3.4/3.5), session-deadline tracking
│   │   └── resolve.ts       station name → id (fuzzy, ambiguity error)
│   ├── tools/               one file per tool, zod schemas + handlers
│   └── fixtures/            captured JSON samples for tests (from recon)
└── tests/                   bun test: payload builders (offline) + gated live read-only checks
```

---

## 2. Tools (v1)

Safety classes: **R** = read-only/idempotent, **G** = money-adjacent, requires `confirm: true` and the calling model must have asked the user.

| # | Tool | Class | Purpose |
|---|---|---|---|
| 1 | `bdz_stations` | R | search 697 stations by name/fragment → `{id, name, abbr, uic}` |
| 2 | `bdz_catalog` | R | seat types, classes, discount card types, add-ons (bike talon), EUR params |
| 3 | `bdz_search_routes` | R | from/to/date (+ optional return date) → train options per date |
| 4 | `bdz_seat_map` | R | coaches + per-seat free/taken state for one train |
| 5 | `bdz_quote` | R | exact total price for a passenger set, creates nothing |
| 6 | `bdz_create_ticket` | **G** | creates the pending ticket(s); returns ids, price, seat, 10-min deadline |
| 7 | `bdz_payment_link` | **G** | creates the payment transaction, returns gateway URL for the user to open |
| 8 | `bdz_check_payment` | R | polls payment status (defaults to the server's last pending purchase) |
| 9 | `bdz_tickets` | R | ticket history (status, price, route, transaction id), paginated |
| 10 | `bdz_ticket_pdf` | R | downloads base64 PDF → saves to a path, returns it |

### Tool contracts

**Passenger object** (shared by quote/create):
```
{ names: string, gender: "m"|"f",
  birth_date?: "DD.MM.YYYY",            // required for sleeper reservations
  discount_card_type_id?: number,       // from bdz_catalog discountCardTypes
  discount_number?: string,             // 12–13 digit card number
  bike?: boolean }                      // adds bike talon addon (id 46)
```

1. **bdz_stations** `{ query?: string }` — substring match, case-insensitive, on cached nomenclatures. Resolves "София" → id 2, "Пловдив" → id 3.
2. **bdz_catalog** `{}` — `seats` (0=—, 23=Седящо I, 25=Седящо II, 10=Спално I, 13=Спално II, 16=Спално бизнес), `classes` (1=Първа, 2=Втора), `discountCardTypes`, `addons`, `paramEur`. Cache 24h in-process; API has a `version` field we can compare later.
3. **bdz_search_routes** `{ from: string|number, to: string|number, date: "YYYY-MM-DD", return_date?: "YYYY-MM-DD" }` — station args accept id or name (fuzzy-resolve; error listing candidates if ambiguous). Body is the legs array (§3.3); with `return_date` a second reversed leg is appended. Output: per date, options `{route_id, departure, arrival, duration, distance, trains:[{train_id, name, full, first_class, second_class, berth, sell_seats}]}`.
   ⚠ **`route_id` is fresh per search/day** — never persist across sessions; always search before seat-map/quote/create.
4. **bdz_seat_map** `{ route_id, train_id, date, from, to, seat_type: 23|25|10|13|16 }` — output: coaches `[{coach_index, coach_type_id, seats:[{seat_id, seat_number, state: "free"|"taken", gender?}]}]` (`seatState` 0=free, 1=taken).
5. **bdz_quote** `{ legs:[{route_id, train_id, date, seat_type, from, to}], passengers: Passenger[] }` — builds the ticket object (§3.4) minus seat ids, `POST GetTicket?onlyPrice=true` → bare number. Output `{total_price, currency: "EUR"}`.
6. **bdz_create_ticket** — same input as quote **plus `confirm: true`** and optional `seat_ids` (from seat map; omitted = auto-assign). Calls `onlyPrice=false` → `{ticketIDs, total_price, passengersTickets[].seats}`. Refuses if `confirm` missing (error text tells the model to ask the user first). Server records `{ticket_ids, transaction deadline = now+10min, payload}` for tools 7–8.
7. **bdz_payment_link** `{ provider: "borica"|"epay", confirm: true }` — uses the pending purchase: `GetTicketPaymentTransaction?&totalPrice=X` body `[ticketIDs]` → `transactionID`; then `Payment/Get/{Borica|Epay}Request?transactionId=N`. Two response shapes (§3.7): `{status:301, url}` → return that URL; `{formFields, url}` → the browser must POST those fields; tool returns the URL **plus a note that it opens via form POST** (fall back: instruct user to buy from the site, or we serve a tiny local redirect page — decide at build time, §8). Refuses if >10 min since create or no pending purchase.
8. **bdz_check_payment** `{ transaction_id? }` — `GET CheckPayment?...`; defaults to last purchase. Also usable: `bdz_tickets` shows `statusID` per ticket (2=issued, 6=cancelled, 11=pending).
9. **bdz_tickets** `{ page?: number, include_old?: boolean }` — `GetUserTickets?pageNum=N` (POST `{}`), `totalPages` included; `include_old` → `GetOldUserTickets`.
10. **bdz_ticket_pdf** `{ ticket_id, save_path? }` — `GET GetTicketPdf?ticketId=` → base64 → write file (default `~/Downloads/{fileName}`), returns `{path, bytes}`.

---

## 3. API reference (reverse-engineered 2026-10-10, all verified)

Base: `https://tickets.bdz.bg/portal/` · Headers on every call: `Authorization: Bearer <token>`, `Accept-Language: bg-BG`, `Content-Type: application/json` (except Token).

### 3.1 Auth
```
POST /Token
Content-Type: application/x-www-form-urlencoded
grant_type=password&username=…&password=…
→ 200 {access_token (662 chars), token_type:"bearer", expires_in:86399,
       userName, firstName, lastName, phone, createdOn, lastLogin,
       gender, birthDate, discountDocumentId, discountDocument,
       ".issued", ".expires"}
→ 400 {error:"unsupported_grant_type"} if grant_type omitted
```

### 3.2 Nomenclatures
```
GET api/Nomenclatures/GetNomenclatures
→ {stations: [{id, name, abbr, uic}] ×697,
   seats: [{id, name, option_group}],          // 0/23/25/10/13/16
   classes: [{id:2,name:"Втора класа"},{id:1,name:"Първа класа"}],
   discountCardTypes: [{id:-1,"Без намаление"},{id:50,"Дете под 7"},
     {id:13,"ЖП карта „Възрастен“"},{id:5,…Дете},{id:…,"Класик","Младеж",
     "Семейство","ТПЛ","Учащ/Студент","ISIC"}],
   addons: [{id:46, abbr:"Талон колело 1", name:"Велосипед", price:1.53}],
   version, paramEur, paramEurStartDate, paramEurExchangeValue}
GET api/Nomenclatures/ClearCache   → cache-buster timestamp (site calls it on load)
```

### 3.3 Route search
```
POST api/POSRoute/Trains
body: [ {date:"YYYY-MM-DD", date_returning:"YYYY-MM-DD"|null,
         station_from:2, station_to:3}          // one-way
      , {date:<return>, station_from:3, station_to:2} ]  // + return leg if round trip
→ [ {date:"11.10.2026", name:"СОФИЯ - ПЛОВДИВ",
     options: [ {id:441650398,                 // route_id — fresh per search!
       departure_time:"06:30", departure_date:"11.10.2026",
       arrival_time:"09:14",   arrival_date:"11.10.2026",
       total_distance:156, total_time:"02:44", is_visible:true,
       trains: [ {id:9, name:"БВ 8611", stations:"СОФИЯ - ПЛОВДИВ",
                  depart, arrive, depart_date, arrive_date, distance, total_time,
                  time_to_wait, full:false, is_delayed:false,
                  information:{first_class:true, second_class:true,
                               berth:false, calendar:false, sell_seats:true}} ] } ] } ]
```
Multi-train options (transfers) = several entries in `trains` with `time_to_wait` on the connection.

### 3.4 Seat map
```
POST api/schema/info
body: {date:"2026-10-11", name:"СОФИЯ - ПЛОВДИВ", route:441650398, train:9,
       people:[{gender:"m", id:1, name:"Любослав Любенов", type:0, seatTypeId:23}]}
→ { "0": {typeId:79,        // keyed by coach index
     seats: [{seatId:38972179, seatNumber:22, seatState:0, genderId:null}, …] } }
// seatState: 0 = free, 1 = taken; genderId set on sleeper seats (1=m,2=f)
```
`api/schema/blockseat` + `api/schema/ReleaseSeat` exist server-side but are **dead code** in the current bundle — the SPA assigns seats through GetTicket only. Don't build on them.

### 3.5 Ticket object + price/ticket creation
```
POST api/Ticket/GetTicket?onlyPrice=true     // quote — creates nothing
POST api/Ticket/GetTicket?onlyPrice=false    // CREATES pending ticket(s)
body (both): {
  paydesk_id:"268", ticket_class:1|2, ticket_type_id:1, trip_type_id:1,
  train_id:0, to_station_id:0, form_station_id:"", tickat_valid_to:"",
  groupRequestId:"", areTogether:true,
  passengers: [ { names, pet:false,
      trains: [ {addons:[], route_id:441650398, seat_type_id:23, train_id:9,
                 seat_id: 38972179 /* optional — omit for auto-assign */} ],
      type_id:"-1",            // -1 = no special type (24 = child, adds passengers?)
      gender:"m"|"f", egn:"", birth_date:"01/1/1990" /* note M/d/yyyy as typed */,
      discount:"",             // discount card id when used
      addons:[], price:"--.--", id:1 } ],
  routes: [ {is_return:"false", route_date:"2026-10-11", route_id:441650398} ] }

onlyPrice=true  → 7.57                        (bare JSON number)
onlyPrice=false → {totalPrice:7.57, ticketIDs:[67116836],
   passengersTickets:[{passengerId, passengerNames, tariffFullText,
     seats:["Запазено място + 0,51 евро","Влак: БВ8611, Вагон: ARk, Място: 22"],
     ticketPrice:7.57, addons:[…], …}]}
```

### 3.6 Payment transaction
```
POST api/Ticket/GetTicketPaymentTransaction?&totalPrice=7.57
     body: [67116836]                          // ticketIDs array
→ {transactionID:1834xxx, description:"…"}
```

### 3.7 Gateway handoff
```
GET api/Payment/Get/BoricaRequest?transactionId=N      // or EpayRequest
→ (a) {status:301, url:"https://…gateway…"}            → browser: location.replace
→ (b) {formFields:{FIELD:value,…}, url:"https://…"}    → browser: hidden POST form
```
Card entry happens on the gateway; nothing for the MCP to do there. Note `?&totalPrice=` — the literal `&` prefix is what the SPA sends.

### 3.8 Payment status + tickets
```
GET  api/Payment/CheckPayment?<query>                   // poll after gateway return
POST api/Ticket/GetUserTickets?pageNum=1   body {}
→ {tickets:[{id, uId:"044012197955", route:"БУРГАС - СОФИЯ - БУРГАС",
     status:"издаден", statusID:2,        // 2=issued, 6=cancelled, 11=pending
     price:43.98, departureDate:"2026-10-06T23:00:00", createDate,
     returnDate|null, transactionID, passenger, canReturnByPOS, bike, …}],
   totalPages:9}
POST api/Ticket/GetOldUserTickets                        // archived tickets
GET  api/ticket/GetTicketPdf?ticketId=66580738
→ {fileName:"Ticket_044012197955.pdf", pdf:"<base64>"}   // verified real PDF
```

### 3.9 Other known endpoints (not in v1)
`api/Ticket/ReclamationRequest` + `CancelReclamationRequest?ticketID=` (refund requests) · `api/Account/{Register, ChangePassword, ChangePhone, ChangeBirthDate, ChangeGender?gender=, ForgotPassword, PasswordReset}` · `api/Content/GetStaticTexts?view=` · `api/Ticket/GetDepartureTrainInfoList` / `GetArrivalTrainInfoList` · `api/Service/WriteJavascriptExceptionToLog`.

### 3.10 Platform constraints (from site copy, observed)
- **10-minute session** starts at search; pending tickets auto-release when it lapses (verified — a test pending ticket vanished, no charge).
- Max passengers per session: 5 seated / 3 sleeper-2nd / 2 sleeper-1st / 1 sleeper-business; mixed genders share a compartment unless bought separately.
- Sale windows & excluded trains are announced on the homepage (e.g. seated sales currently to 19.10; БВ1621 София–Пловдив excluded). Surface the homepage banner text in `bdz_search_routes` errors when relevant.
- Reservation is mandatory on fast trains (БВ); not required on ПВ/КПВ.
- Seat choice optional — omitted seat → system auto-assigns.

---

## 4. Safety design

- **Gated tools**: `bdz_create_ticket` / `bdz_payment_link` require `confirm: true`; tool descriptions instruct the calling model to get explicit user approval (route, date, passengers, price) first. Missing `confirm` → refusal with instructions, not a crash.
- **Deadline guard**: payment_link/check_payment refuse once >10 min past create; error suggests re-quote (prices/availability change anyway).
- **No blind retries** on purchase endpoints; retries only on idempotent reads + the single 401-relogin-retry.
- **Credentials**: `.env` only; token cache `chmod 600`; nothing auth-related in logs; errors never echo the token.
- **No auto-payment, ever** (v1 and by design): the gateway URL is the handoff.

---

## 5. Testing

1. **Offline unit** — payload builders + response parsers against captured fixtures (`src/fixtures/`: search response, seat map, preview, tickets page, token response). Station fuzzy-resolver cases (exact, partial, ambiguous, id passthrough).
2. **Live read-only** — a script hitting stations/search/seat-map/quote for Sofia→Plovdiv tomorrow; asserts shapes, no side effects. Safe to run anytime.
3. **Create-and-expire** — gated behind an explicit env (`BDZ_LIVE_CREATE=1`): creates one pending ticket on a cheap route, asserts the response, then **lets it expire** (never calls payment_link in tests). Verified harmless during recon.
4. **Manual E2E** — one real purchase by the user, agent-driven, paying the gateway URL in their own browser.

---

## 6. ZCode registration

At build time, register the stdio server (command `bun`, args `…/bdz-tickets/src/index.ts`) in the user-scope MCP config so it's available in every workspace, then verify with a live `bdz_stations` call. (Exact config file per current ZCode docs — `zcode mcp add` / user settings — checked during milestone 5.)

---

## 7. Build order

1. **M1 — read-only core**: scaffold, auth+token cache, nomenclatures cache, stations/search tools. Usable for lookups immediately.
2. **M2 — availability & price**: seat map + quote (payload builders + fixtures).
3. **M3 — purchase**: create_ticket + payment_link + check_payment, gated, deadline-aware.
4. **M4 — library**: tickets list + PDF download.
5. **M5 — polish**: ZCode registration, README, error-message pass (plain language), git init + first commit, optional push to Gitea (`lyubo/bdz-tickets`, private).

---

## 8. Open items / decisions at build time

- **Gateway form-POST case** (3.7b): if ePay/Borica returns `formFields`, a bare URL isn't enough. Options: (a) tiny local HTML page the tool writes that auto-submits the form, (b) instruct the user manually. Lean (a).
- **Reclamation (refund) tooling** — v2 once v1 is proven.
- **Multi-profile support** (more than one BDZ account) — not needed now.
- **`GetDepartureTrainInfoList`/`GetArrival`** — only if transfer-route details prove necessary.
