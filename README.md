# EventPay Sentinel

> A real-time payment command center for mass events that connects registrations, Razorpay payment events, fraud signals, and participant communication in one trusted interface.

**Core question it answers:** "Can this participant enter, and can I prove that their payment is genuine?"

## The Problem

During large Indian events (college fests, conferences, concerts), organizers use Google Forms + UPI QR + WhatsApp screenshots + Google Sheets + volunteers for manual verification. This breaks at scale:

- Thousands of registrations arrive simultaneously
- Participants enter wrong UTRs
- One payment claimed by multiple people
- Payment screenshots can be edited or reused
- Volunteers cannot reliably verify payments at the gate
- Organizers don't know actual amount collected

## How EventPay Sentinel Solves This

```
Registration → Payment Link → Razorpay Webhook → Cryptographic Verification →
Risk Analysis → Entry Decision → QR Pass → Gate Scan → Audit Trail
```

## Features

- **Registration Intake** — Google Forms integration or manual entry, unique REG IDs
- **Razorpay Payment Verification** — Webhook signature verification, auto-matching
- **Risk Engine** — Duplicate UTR detection, amount mismatch, payment-not-found, reused payments
- **Command Center** — Live dashboard with metrics, risk alerts, entry readiness
- **Entry Scanner** — Volunteer scans REG ID, instant approve/hold decision
- **AI Investigation** — Ask questions like "Who can enter?" or "Show suspicious claims"
- **Messaging** — Automated participant notifications
- **Reconciliation** — Expected vs captured vs settled breakdown
- **Audit Log** — Every action traced with actor, timestamp, reason

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | React + Vite |
| Backend | Node.js + Express 4 |
| Database | MongoDB Atlas |
| Payments | Razorpay (webhooks, payment links, QR) |
| AI | Groq (Llama 3.3 70B) |
| Email | Resend |
| Auth | JWT + bcrypt |

## Quick Start

```bash
git clone https://github.com/Majenayu/RAZOOOO.git
cd RAZOOOO
cp .env.example .env  # Fill in your keys
npm install
npm run dev
```

- Frontend: http://localhost:5000
- API: http://localhost:3001

## Demo Flow

1. Register → Create event (RazorFest 2026 with 3 ticket types)
2. Click "Seed demo data" → 6 registrations appear (verified, suspicious, mismatch, duplicate, pending)
3. Command Center → See live metrics and risk alerts
4. Risk Queue → Review critical/high alerts
5. Entry Scanner → Check in verified participants
6. AI → Ask "Who can enter right now?"
7. Reconciliation → See expected vs captured gap

## API Endpoints

### Auth
- `POST /api/auth/register` — Create account (organizer/volunteer/finance)
- `POST /api/auth/login` — Login, get JWT

### Events
- `POST /api/events` — Create event with ticket types
- `GET /api/events` — List your events
- `GET /api/events/:id/metrics` — Live dashboard metrics

### Registrations
- `POST /api/events/:id/registrations` — Add registration (creates Razorpay link)
- `POST /api/intake/:token` — Google Form intake (token-protected)
- `GET /api/events/:id/registrations` — List all with filters

### Payments & Verification
- `POST /api/webhooks/razorpay` — Webhook (signature verified)
- `GET /api/events/:id/payments` — All payment events

### Risk & Entry
- `GET /api/events/:id/risk-queue` — Open risk alerts
- `POST /api/events/:id/registrations/:regId/approve` — Approve entry
- `POST /api/events/:id/registrations/:regId/hold` — Hold entry
- `POST /api/events/:id/entry/:regId/check-in` — Gate check-in
- `GET /api/entry-pass/:token` — Verify entry pass

### AI & Reports
- `POST /api/events/:id/ai/investigate` — Ask AI questions
- `GET /api/events/:id/reconciliation` — Financial reconciliation
- `GET /api/events/:id/audit` — Audit trail

## Architecture

```
Client [React + Vite] → API [Express + JWT]
                              ↓
                        MongoDB Atlas
                              ↓
              Razorpay Webhooks → Payment Matching → Risk Engine
                              ↓
                        Groq AI (Investigation)
```

## Positioning

> **"The trust and operations layer for high-volume Indian digital payments."**

Not a Google Form payment tracker. A real-time verification command center that proves payment authenticity cryptographically.

## License

MIT
