# Stylist System — booking, clients & SMS for a solo stylist

Self-contained (no Square, no npm deps). Runs on [Bun](https://bun.sh) with built-in SQLite.

> **Demo build:** every service, price, hour and policy in `config/` is **SAMPLE content** modeled on typical
> independent-salon menus. Replace it with real details before going live. The address and phone are blank placeholders.

## Run
```bash
ADMIN_PASSWORD='choose-a-password' PORT=3456 ./start.sh
```
If `ADMIN_PASSWORD` is unset, the dashboard password is `demo-pass-2026`.
- Booking page: `http://localhost:3456/`  ·  Dashboard: `/admin`  ·  Health: `/health`
- Data: `data/salon.db` (SQLite; tables `clients`, `appointments`, `messages`, `visits`). Back this file up.
- `start.sh` sets `TZ` from `config/business.json` → `timezone`; all appointment times are stored in that local time.

| Env var | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Dashboard password. Defaults to `demo-pass-2026` when unset so the demo login works |
| `PORT` | default 3456 |
| `PUBLIC_BASE_URL` | Public https URL (used in booking links in texts and for Twilio signature checks) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Enable real SMS. If any is unset → **dry-run**: texts are only logged in the DB/dashboard |
| `DB_PATH` | optional alternate DB file |

## Configure (edit, then restart)
`config/business.json`
- `businessName`, `stylistName`, `address`, `phoneDisplay`, `timezone`
- `workingHours`: per weekday list of `["HH:MM","HH:MM"]` ranges (`[]` = closed; use two ranges for a lunch break)
- `closedDates`, `slotIntervalMinutes`, `bufferMinutes` (cleanup gap between clients), `minNoticeHours`, `bookingWindowDays`
- `services[]`: `id`, `name`, `category`, `durationMinutes`, `priceFrom`, `priceTo`, `description`, `depositRequired`, `sample` (remove `sample:true` to drop the "sample" tag)
- `policies`: cancellation / deposit / late / pricing text shown on the booking page and used in FAQ replies

`config/faq.json` — auto-draft rules for inbound texts. First rule whose keyword appears wins. Templates can use
`{bookingLink} {address} {hours} {prices} {businessName} {stylistName} {phone} {cancellationPolicy} {depositPolicy} {latePolicy}`.
Rules with `"booking": true` always include the booking link. Price questions naming a service (e.g. "balayage") get that service's price.

## How it works
- **Booking:** slots computed from hours − existing booked/confirmed appointments (+buffer). Booking is re-validated and inserted in a SQLite `BEGIN IMMEDIATE` transaction, so two simultaneous requests can't take the same time.
- **Dashboard:** today/upcoming, confirm / complete (adds to visit history) / cancel (texts client) / reschedule (overlap-checked, texts client); client list + profile (notes, visits, appointments, full text thread, send a text); inbox of client texts with an editable auto-drafted reply — nothing is auto-sent to inbound messages, she approves each reply.
- **Scheduler** (every 60 s): sends a confirmation text for new bookings and a reminder once an appointment is within 24 h.
- **SMS:** `POST /sms/inbound` (Twilio webhook, validates `X-Twilio-Signature` when the auth token is set, replies with empty TwiML). `POST /sms/status` accepts Twilio delivery status callbacks. Outbound in `sms.ts`.

Simulate an inbound text:
```bash
curl -X POST localhost:3456/sms/inbound --data-urlencode From=+15555550101 --data-urlencode "Body=How much is balayage?"
```

## Deploy on Render (free)

`render.yaml` is a Render blueprint for a free-tier Docker web service.

1. Push `main` to GitHub.
2. In the Render dashboard: **New → Blueprint**, and connect this repo. Render reads `render.yaml`.
3. When the blueprint asks for `ADMIN_PASSWORD`, leave it blank to use `demo-pass-2026`, or enter your own. It is declared `sync: false`, so later dashboard edits are not overwritten by the blueprint.
4. Apply the blueprint. The service builds the `Dockerfile` (`oven/bun:1`), listens on `0.0.0.0` and `PORT` (Render sets `PORT`), and creates `data/` when the process starts.
5. Open the service URL at `/` (booking) and `/admin` (dashboard). Health check: `/health`.
6. Optional, on the service **Environment** tab: set `PUBLIC_BASE_URL` to the Render `https://…onrender.com` URL, and the `TWILIO_*` variables if you want live SMS. Save so Render redeploys.

The database is SQLite on the instance disk. Free web services have an ephemeral disk, so clients and appointments reset when the instance is replaced; an empty database is seeded again on startup with fictional 555-number demo data.

## Going live with Twilio
1. Host it at a public https URL (a small VPS, Fly.io/Render, or a tunnel such as Cloudflare Tunnel for testing). Set `PUBLIC_BASE_URL`.
2. Create a Twilio account, buy a local SMS-capable number. US numbers must complete **A2P 10DLC** registration (brand + campaign) before texting reliably — allow days to a couple of weeks.
3. In the number's settings → Messaging → "A message comes in": Webhook, `POST`, `https://YOUR-DOMAIN/sms/inbound`.
4. Set the three `TWILIO_*` env vars and restart; the dashboard badge changes from "SMS dry-run" to "SMS live".
5. Twilio handles STOP/HELP opt-out keywords automatically on US numbers.

**Her existing number — options**
- **Give clients the new Twilio number** for texting/booking (simplest; keep her personal cell private). Put it on the booking page, IG bio, cards.
- **Port her existing number into Twilio** (Twilio Console → Port & Host). Texts and calls then land in Twilio; set up call forwarding to her cell via a TwiML Bin/Studio flow. Note: porting moves the number off her phone carrier.
- **Host SMS only** ("Hosted SMS" for a landline/VoIP number she keeps for calls) where Twilio supports it.
- Plain carrier call-forwarding forwards **calls, not texts** — it won't bring texts into this system.

## Not done / next steps
- Payments/deposits are only described, not collected (would need Stripe or similar).
- No client self-service cancel/reschedule link (clients text instead; she handles it in the dashboard).
- Single admin password, no rate limiting on the public booking API; run behind HTTPS.
- Email is collected but no emails are sent.
