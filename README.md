# Do Good Co. API (MVP)

A real REST API backed by a real SQLite database — seeded with realistic demo
data so the product can be pitched end-to-end today, and swapped for a
production database later without touching the routes or the client.

## Why zero dependencies

`npm install` needs registry access, which isn't always available (locked-down
networks, CI sandboxes, etc). So this server is built entirely on Node.js 22
built-ins:

- `node:http` — the HTTP server and a ~60-line router (`src/lib/http.js`)
- `node:sqlite` — a real SQL database, no native module compilation required

There is nothing to `npm install`. Just run it.

## Run it

```bash
cd server
node src/index.js
# Do Good Co. API listening on http://localhost:4000
```

Requires **Node.js 22.5+** (for `node:sqlite`). Check with `node -v`.

First run creates `server/data/karmaquest.sqlite` and seeds it with ~26 demo
users, 40 quests across all 10 Do Good Co. categories, community proofs,
badges, wallet transactions and a flagged-proof moderation queue. Delete that
file to reset to a fresh seed.

## Swapping in a real backend later

Every route returns `{ data: ... }` on success and `{ error: { message, details } }`
on failure — keep that shape and the React client needs zero changes beyond
`client/src/config.js`'s `API_BASE_URL`. The route contracts:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/auth/demo-accounts` | – | List of demo logins for the pitch |
| POST | `/api/auth/login` | – | `{ phone }` -> `{ token, user }` |
| POST | `/api/auth/logout` | ✓ | Invalidate the session token |
| GET | `/api/auth/me` | ✓ | Current user |
| GET | `/api/categories` | – | 10 quest categories |
| GET | `/api/quests` | – | `?category=&type=&search=` |
| GET | `/api/quests/:id` | – | Quest detail |
| POST | `/api/quests/:id/proofs` | ✓ | Submit proof of a completed deed |
| GET | `/api/proofs/feed` | – | Mohalla/city community feed |
| POST | `/api/proofs/:id/upvote` | ✓ | Community verification |
| POST | `/api/proofs/:id/flag` | ✓ | Report a suspicious proof |
| GET | `/api/leaderboard` | ✓ | `?scope=mohalla\|city` |
| GET | `/api/leaderboard/mohallas` | – | Mohalla vs. mohalla ranking |
| GET | `/api/wallet` | ✓ | Balance + transaction history |
| GET | `/api/wallet/redemption-options` | ✓ | UPI/NGO/voucher catalog |
| POST | `/api/wallet/redeem` | ✓ | Spend Karma Coins |
| GET | `/api/profile/me` / `/:userId` | ✓ | Badges, stats, activity |
| GET | `/api/moderation/queue` | ✓ admin | Flagged proofs |
| GET | `/api/moderation/stats` | ✓ admin | Trust engine dashboard stats |
| POST | `/api/moderation/:id/approve` \| `/reject` | ✓ admin | Moderator action |
| GET | `/api/proofs/:id/comments` | – | List comments on a proof |
| POST | `/api/proofs/:id/comments` | ✓ | `{ text }` -> add a comment |
| GET | `/api/messages/conversations` | ✓ | Inbox: all conversations + unread counts |
| POST | `/api/messages/conversations` | ✓ | `{ userId }` -> get or create a DM thread |
| GET | `/api/messages/conversations/:id` | ✓ | Thread messages (marks incoming as read) |
| POST | `/api/messages/conversations/:id/messages` | ✓ | `{ text }` -> send a DM |
| GET | `/api/messages/unread-count` | ✓ | Total unread DMs (for the nav badge) |
| GET | `/api/wallet/daily-spin/status` | ✓ | Whether today's free spin is available |
| POST | `/api/wallet/daily-spin` | ✓ | Claim today's Karma Spin bonus |
| GET | `/api/ngo/organization` \| `/dashboard` \| `/quests` \| `/proofs` | ✓ ngo admin | NGO partner console |
| POST | `/api/ngo/quests/:id/feature` | ✓ ngo admin | Toggle Premium Listing |
| POST | `/api/ngo/proofs/:id/verify` | ✓ ngo admin | Issue an NGO Verified badge |

Quest proof submission (`POST /api/quests/:id/proofs`) also accepts optional
`mediaType` (`"image"` \| `"video"`) and `mediaData` (a base64 data URL) —
that's the real photo/video capture feed posts render.

Auth is a bearer token (`Authorization: Bearer <token>`) issued by `/api/auth/login`
and checked against the `sessions` table. It's intentionally simple (phone
number, no OTP) for demo purposes — swap `src/routes/auth.js` for real
OTP/JWT/OAuth when you're ready; nothing else depends on how the token was
issued.

## Notable design choices worth mentioning in a pitch

- **Trust Engine is real, not decorative.** `src/routes/quests.js` implements
  the deck's "5 community upvotes -> XP credited" rule and
  `src/routes/moderation.js` implements the "3+ flags -> moderator queue"
  rule, exactly as specified. The only simulated part (clearly commented in
  the code) is that a fresh solo demo account gets simulated upvotes so you
  can demo the full loop without needing 5 real people in the room.
- **Levels and tiers** (`src/lib/levels.js`) mirror the deck's Sevak → Karma
  Hero → Dharma Guardian progression.
- **Gamification math** (badges, XP, coins) lives in `src/lib/gamification.js`,
  isolated from the route handlers so it's easy to unit test or extend.
