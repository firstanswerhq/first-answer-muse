# First Answer Sight

**See it. Size it. Solve it.** A customer texts one photo to a local business, with something of known size in the shot (a quarter, a gift card, a sheet of paper, the garage door). The customer gets the measurement, what to buy and what to do next, in English or Spanish. One tap on **Send this to the business** puts the job size, the materials and a quote line from the business's own price list on the owner's board as a lead.

Built on Meta's models for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026), Startups track. Sight is the photo step of **First Answer**, the AI front desk that answers every text, photo, voicemail and call for a small service business.

- Customer page: `/measure.html`
- Front desk (text, photo, voicemail, live call): `/` and the owner board `/owner.html`

## The problem

"How big is it?" costs local service businesses real money. A tile installer, a driveway sealer, an auto-glass shop or a shed builder can't quote until they know the size, so they go back and forth by text ("can you measure it?", "which way is long?") or they drive out for a site visit that may never turn into a job. Customers who don't get a number quickly call the next company.

## Who benefits

- **Local service businesses** (flooring and tile, driveway sealing and pressure washing, auto glass, sheds and outdoor buildings, tree work): a sized, priced lead from one photo, without a site visit for the first quote.
- **Their customers**: an answer in seconds, in plain words, with what to buy and what to do, instead of waiting for a callback.
- **First Answer**: Sight turns a photo into the same structured job (size, materials, quote line) the front-desk agent already books from.

## How it works

One photo and one line of text in. Meta's models read and outline; our geometry does every bit of math.

```
photo + "how much sealer for my driveway?"
   │
   ├─ Meta Muse Spark 1.3 ─ reads the photo and the question: which task, what to measure, which ruler is in the shot
   │
   ├─ Meta SAM 3.1 ──────── outlines the thing and the ruler (one call per concept, in parallel), with masks and confidence
   │
   ├─ Our geometry ──────── turns pixels into inches: perspective maps from the ruler, horizon from the ground edges, ± ranges
   │
   ├─ Meta Muse Spark 1.3 ─ CHECKS SAM: sees the photo with SAM's masks drawn on it plus a close-up of each, and must
   │                        agree each outline is the right thing; if not, no number goes out, only a retake tip   ┐ in
   └─ Meta Muse Spark 1.3 ─ words a 2–3 sentence answer from OUR numbers, in the customer's language; every       ┘ parallel
                            number, unit and verdict is checked, or the template is used
```

| Step | Who does it | What it does | Can it change a number? |
| --- | --- | --- | --- |
| Read the task | **Muse Spark 1.3** (vision, JSON schema output) | Picks the task (tile, chip, shoe, gap, driveway, size, face), the target, the ruler (coins from US, Canada, Europe and the UK, cards, paper, bills, cans, doors) and the language of the message | No |
| Outline | **SAM 3.1** (Responses API, masks + confidence) | Outlines the target and the ruler. The reply draws SAM's real masks over the customer's photo (target and ruler in different colors, each with SAM's confidence) | No |
| Measure | **Our geometry** (`src/flat.js`, `src/measure.js`, `src/distance.js`, `src/face.js`) | Four-corner perspective map or tilted-coin correction for close-ups; door height + horizon for driveways; camera pose for ground gaps and heights; card-on-forehead mapping for faces | It makes them |
| Plan | **Our rules** (`src/tiles.js`, sealer coverage, repair limits, shoe chart) | Tiles to buy and the cut list, gallons of sealer, repair or replace, shoe size | It makes them |
| Check SAM's work | **Muse Spark 1.3** (multi-image vision, JSON schema output) | `src/overlay.js` draws SAM's masks onto the photo (magenta = what we measure, orange = the ruler, blue = the other side of a gap) and crops a close-up of each. Spark must say every outline is what we think it is. If it disagrees, the customer gets "Retake needed" with a specific tip (a wrong coin gets "say it's a dime") and the outlines, never a number. 10 s timeout; if Spark doesn't answer, the panel says the check was skipped | It can stop one |
| Word the answer | **Muse Spark 1.3** | Writes the answer and next step from our numbers only, in English or Spanish (from the read). `checkWording()` pairs every number with its unit (sq ft, gallons, pails, in, ft, mm, cm, tiles, %, US/EU, men's/women's, in English and Spanish) and rejects any pair, number word or price that isn't in our facts, a reply missing the headline number and unit, and a reply that leaves out or contradicts a repair/replace or fits/tight/won't-fit verdict. On a fail the English template is kept. 6 s timeout, no retries | No: checked |

The page labels this honestly: **"Spark wording · numbers from geometry, checked"** (with **"en español"** for Spanish) when Spark's text passed the check, **"Numbers from geometry"** when the template was kept. Under the photo, a key lists SAM's masks with their confidence and what Spark said when it checked them. While the models work, the waiting steps follow real progress streamed from the server (one NDJSON line per finished step), and the reply's "How Meta's models measured it" panel shows each step's real output and timing. Failed calls show a short reason ("no reply in 6 s", "Meta's server had a hiccup (500)"), never a raw upstream error.

### What the business gets

Every answer (except Face, which is measurement-only) ends with a block for the business: job size, materials and a quote line, and a **Send this to <business>** button with an optional phone field. Tapping it creates a real lead on the owner board (`/owner.html`, channel "sight") and shows the customer a confirmation with a link to the board. The button sends only the answer's server-side id (kept for 2 hours) and the phone number, so what lands on the board is exactly what Sight measured.

Prices come only from the business's own price list (`business.sight` in `src/business.js`). In the demo, Brightside Exterior Care prices driveway sealing at $0.30 per sq ft (job minimum $199), so a driveway answer carries the arithmetic, for example `420 sq ft × $0.30 per sq ft = $126; job minimum $199`. A job that isn't on the price list (a windshield chip for an exterior-cleaning company) still goes to the board, marked for the owner to price: `$X per chip repair (set by the business)`. Sight never invents a price.

## The five demo tasks

| Chip | The customer sends | They get | The business gets (on Send) |
| --- | --- | --- | --- |
| **Tile floor** | The floor with a sheet of printer paper on it | Floor size and sq ft, tiles to buy (+ waste), a centered layout and cut list | Sq ft, tile count, `sq ft × $X per sq ft installed` |
| **Windshield chip** | The chip with a quarter beside it | Repair or replace (under a quarter / a 6 in crack), with the size and range | Repair or replacement, `$X per chip repair` |
| **Shoe size** | A foot on a sheet of paper | Foot length, US men's / women's and EU size | Size and width for a fitting |
| **Shed fit** | The side yard with a door in the shot | Narrowest and typical gap, fits / tight / won't fit for the shed width they typed | Gap, unit width, pad, install quote line |
| **Driveway** | The driveway with the garage door at the far end | Sq ft with a range, size, sealer per coat (concrete gallons or asphalt pails) | Sq ft range, sealer, `sq ft × $X per sq ft` |

A sixth chip, **Face** (a gift card held flat on the forehead), measures eye spacing and face proportions. It is last in the row and always carries the note: *Measurements only, not a medical opinion, and not for ordering prescription glasses.*

## Accuracy and limits

Every answer says what it was measured against, for example **Measured against: quarter (24.26 mm)** or **double garage door (16 × 7 ft)**, and carries a range or a confidence.

| Task | Range shown | Tested against |
| --- | --- | --- |
| Close-up with paper, card, bill or plate | ±3% of the length (never finer than about 1.5 pixels at the target) | Rendered scenes with known sizes at angles up to 35° (`test/flat.test.js`, `test/anything.test.js`, `test/trust.test.js`) |
| Close-up with a coin | ±4%, ±6% when the coin is seen at more than 30° | Same |
| Any close-up marked "Rough" | +8% on top of the above | Same |
| Tile floor area | twice the length range (area) | Rendered 12 × 10 ft floor, within 7% |
| Driveway / patio | ±12% when the geometry checks out, ±30% when it doesn't | Rendered driveways 432 and 1,500 sq ft, within 12–15%; steep side angles are never marked good (`test/measure.test.js`, `test/surface.test.js`) |
| Ground gap, height, distance | low–high range from the camera pose spread | Rendered 3D yards (`test/distance.test.js`) |
| Face | about ±5% for eye spacing; nose and mouth are rough | Rendered 3D heads (`test/face.test.js`) |

The numbers above come from synthetic scenes with known answers. Real-photo accuracy will be checked with the sample photos before judging.

**It refuses or asks again instead of guessing when:** Muse Spark looks at SAM's outlines and disagrees (the outline caught the wrong thing, or the coin is a different coin), there is no ruler in the shot, the ruler is partly hidden or bent, the thing runs off the edge of the photo, a coin is used for something much bigger than itself at an angle, a driveway photo has no garage or front door, the angle is too steep to find the horizon, SAM can't find the target, or (Face) the card is covered, the head is turned, there are glasses or two faces. Ruler-limit cases (a chip within measuring error of the repair limit) say so.

**Rate and access limits:** `/api/measure` and `/api/photo` allow 20 photos per 10 minutes per IP (Cloudflare `cf-connecting-ip`, then `true-client-ip`, then the rightmost `x-forwarded-for` entry, which Render's proxy appends, then the socket address). A global cap on Meta calls per day (`META_DAILY_CAP`, default 1,500, reset at midnight UTC) counts every Meta call, so rotating IP addresses can't drain the credits; endpoints refuse up front when a request can't fit. `/api/diag` model probes need `DIAG_TOKEN`. The public owner board is redacted with an allowlist of fields (no phone numbers, addresses, full names, notes from the agent or voicemail text) unless opened with `OWNER_TOKEN`.

## Run it

```bash
npm install
npm test                         # 134 tests, no key needed, no Meta credits spent (fixtures and stand-ins)
npm start                        # http://localhost:3000/measure.html
MODEL_API_KEY=... npm start      # live on the Meta Model API
```

| Env var | What it does |
| --- | --- |
| `MODEL_API_KEY` | Meta Model API key (never sent to the browser) |
| `META_RELAY_URL` | Optional relay for hosts Meta's API turns away (`direct` to call Meta directly) |
| `DIAG_TOKEN` | Unlocks `/api/diag` model probes (send as `x-diag-token`) |
| `OWNER_TOKEN` | Full owner board: open `/owner.html#key=...` (the part after `#` never reaches the server; the page sends it as the `x-owner-key` header and clears it from the address bar). Keys in the query string are ignored |
| `MEASURE_LIMIT` | Photos per 10 minutes per IP on `/api/measure` (default 20) |
| `PHOTO_LIMIT` | Photos per 10 minutes per IP on `/api/photo` (default 20, never more) |
| `META_DAILY_CAP` | Meta calls per day across all visitors (default 1500) |

**Sample photos:** put `public/samples/<id>.jpg` (or `.png`/`.webp`) with `public/samples/<id>.txt` beside it: first line is the chip label, the rest is the message sent with the photo. Ids: `tile`, `windshield`, `shoe`, `shed`, `driveway`, `face`. A chip with a photo gets a glowing dot and sends the photo when tapped; the photos are served as static files from `/samples/`.

Node 22, Express, the OpenAI SDK pointed at the Meta Model API, `@meta-sam/parser` for SAM masks, `jpeg-js` for drawing SAM's outlines for Spark's check, `ws`, `multer`. Hosted on Render (`render.yaml`).

### Code map

- `src/anything.js`: the Sight flow (read, outline, measure, Spark's check of SAM, word, business block) and the wording check.
- `src/overlay.js`: draws SAM's masks onto the photo and crops close-ups for Spark's check (pure JS).
- `src/flat.js`: close-up measuring next to an everyday ruler (homography, tilted coin), with ± ranges.
- `src/measure.js`: driveways and patios in square feet from a door's height and the ground's horizon.
- `src/distance.js`: camera pose from one photo; ground gaps, heights, distances with ranges.
- `src/face.js`: card-on-forehead face measurements.
- `src/tiles.js`: tile layout and cut list. `src/rulers.js`: catalog of known-size objects.
- `src/muse.js`: Meta Model API client (Muse Spark chat, vision and multi-image check, SAM 3.1, Muse Image, Muse Voice Transcribe); every call counts against the daily cap.
- `src/guard.js`: per-IP rate limit, global daily Meta cap, token checks, owner-board redaction (allowlist).
- `src/server.js`: Express API, NDJSON progress stream for `/api/measure`, the hand-off to the owner board (`/api/measure/send`), owner live feed, live-call relay.
- `public/measure.html|js|css`: the Sight page.

## Built during the hackathon (Oct 26 – Nov 4, 2026)

Every commit in this repository is from the hackathon window; the first is Oct 27, 2026.

| Date | Feature | Commits |
| --- | --- | --- |
| Oct 27 | Repo started; First Answer front desk on Meta Muse: text, photo, voicemail and live call (`index.html`, `owner.html`) | `5ee69d8`, `cad0b14` |
| Oct 27 | Model access diagnostics (`/api/diag`) | `579df0b`, `06b17bc`, `73bd06c`, `98b5f92` |
| Oct 27 | SAM 3.1 masks decoded; driveway square feet from the garage door | `d0510d8`, `c92d46b` |
| Oct 28 | Optional relay for Meta Model API calls | `5d82406`, `4fc5a2d`, `5261742` |
| Oct 28 | Everyday rulers (cards, paper, bills, cans, coins); ruler catalog | `9e333f6`, `4b87e21` |
| Oct 28 | Tile planner: centered layout, cut list, tiles and boxes | `1df43fb` |
| Oct 28 | Distance from one photo: gaps, heights, ranges | `75e8de8` |
| Oct 28 | Measure anything: one photo + one line to an answer; the Sight page | `db2a809`, `9bda8a1`, `6d5c2c9`, `937b656` |
| Oct 28 | Coins from Canada, Europe and the UK | `912a966`, `3b8aa28` |
| Oct 28 | Face mode (card on forehead), four review rounds | `11e7239`, `674b342`, `fdb647f`, `80ad78d`, `47ebda1`, `e7bfae5`, `0780efa`, `150258e`, `e2069e3` |
| Oct 28 | Named First Answer Sight | `3eed1bd` |
| Oct 28 | Locked down credit-spending and customer-data endpoints | `ba0d84f` |
| Oct 28 | Driveway chip routed to the square-feet engine, with sealer | `9dad51b` |
| Oct 28 | ± ranges on close-ups; "Measured against" on every answer | `b492d06` |
| Oct 28 | Muse Spark words the answer from our numbers (checked); real progress; Meta detail panel; specific errors | `801fc2c` |
| Oct 28 | "Send to the business" block; sample photos as static files | `fdb2617` |
| Oct 28 | Page: progress, wording tag, ruler line, business hand-off, Retry, chip order, Meta badges on phones | `6fb8947` |
| Oct 28 | Wording check pairs numbers with units and guards verdicts; plain-word errors; lock-down (rightmost XFF, daily Meta cap, allowlist redaction, owner key in a header) | `2c60e36`, `cd063ae`, `e78604c` |
| Oct 28 | Send to the business for real: leads on the owner board, priced from the price list | `261112f` |
| Oct 28 | Muse Spark checks SAM's outlines before any number goes out; Spanish answers; SAM confidence and Spark's verdict on the photo | `11c27d4`, `e87d2f2` |

See `git log` for the full history.

## What existed before

- **First Answer, the company and the concept** (an AI front desk for local service businesses) existed before the hackathon. This codebase did not.
- **`first-answer-deposits`** is a separate, earlier repository (First Answer's PayPal hackathon entry). No code from it is in this repository.
- The **front-desk pages** (`public/index.html`, `public/owner.html`, `public/app.js`) were built on Oct 27, inside the window, as the agent flow Sight plugs into.

## License

MIT
