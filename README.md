# First Answer Sight

**See it. Size it. Solve it.** A customer texts one photo to a local business, with something of known size in the shot (a quarter, a sheet of paper, the garage door). The customer gets the measurement, what to buy and what to do next, in English or Spanish (a Spanish question gets the whole card in Spanish). One tap on **Send this to the business** puts the job size, the materials, a quote line from that business's own price list and the photo with SAM's masks on the owner's board as a lead.

Built on Meta's models for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026), Startups track. Sight is the photo step of **First Answer**, the AI front desk that answers every text, photo, voicemail and call for a small service business.

- Customer page: `/measure.html`
- Front desk (text, photo, voicemail, live call): `/` and the owner boards `/owner.html` (all demo businesses) or `/owner.html?b=<business id>`

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
   ├─ Meta Muse Spark 1.3 ─ CHECKS SAM: sees the photo with SAM's masks drawn on it plus a close-up of each, and must  ┐ in
   │                        agree each outline is the right thing                                                    │ parallel
   ├─ Meta Muse Spark 1.3 ─ words the answer from OUR numbers, in the customer's language (checked, or the template)  ┘
   │
   └─ if Spark disagrees ── Spark tells SAM what to look for (a better phrase and a point on the photo) → SAM 3.1
                            outlines it once more → our geometry re-measures → Spark checks again. One round; if Spark
                            still disagrees, no number goes out, only the outlines and a retake tip
```

| Step | Who does it | What it does | Can it change a number? |
| --- | --- | --- | --- |
| Read the task | **Muse Spark 1.3** (vision, JSON schema output) | Picks the task (tile, chip, shoe, gap, driveway, size), the target, the ruler (coins from US, Canada, Europe and the UK, cards, paper, bills, cans, doors) and the language of the message | No |
| Outline | **SAM 3.1** (Responses API, masks + confidence) | Outlines the target and the ruler. The reply draws SAM's real masks over the customer's photo (target and ruler in different colors, each with SAM's confidence) | No |
| Measure | **Our geometry** (`src/flat.js`, `src/measure.js`, `src/distance.js`) | Four-corner perspective map or tilted-coin correction for close-ups; door height + horizon for driveways; camera pose for ground gaps and heights | It makes them |
| Plan | **Our rules** (`src/tiles.js`, sealer coverage, repair limits, shoe chart) | Tiles to buy and the cut list, gallons of sealer, repair or replace, shoe size | It makes them |
| Check SAM's work | **Muse Spark 1.3** (multi-image vision, JSON schema output) | `src/overlay.js` draws SAM's masks onto the photo (magenta = what we measure, orange = the ruler, blue = the other side of a gap) and crops a close-up of each, in a worker thread (the photo size is read from the JPEG header first; above 2.5 MP, or for a PNG/WebP, Spark gets the plain photo and SAM's boxes as pixel coordinates in the prompt instead). Spark must say every outline is what we think it is. 10 s timeout, which covers drawing too; if Spark doesn't answer, the number goes out marked **unchecked** (on the page, on the owner board and in the hand-off) | It can stop one |
| Correct SAM | **Muse Spark 1.3 → SAM 3.1** | When Spark disagrees, it returns a better concept phrase and a point on the right thing. SAM 3.1 runs once more with the point (object-prompt text built by `@meta-sam/parser`'s `buildObjectPrompt`; if SAM can't use it, the phrase instead), our geometry re-measures, and Spark checks again. At most one round. Still wrong, or no second check in time: no number, a retake tip. A wrong coin is never "corrected" (its size changes); the customer is asked to say which coin it is. The page says "Muse Spark corrected SAM's outline → SAM 3.1 outlined it again → re-measured" and the panel lists both attempts; SAM's first try stays on the photo, dashed | It can redo one |
| Word the answer | **Muse Spark 1.3** | Writes the answer and next step from our numbers only. `checkWording()` is an allowlist: every number in Spark's text must carry a unit we know (sq ft, gallons, pails, in, ft, mm, cm, tiles, %, hours, °F, US/EU, men's/women's, in English and Spanish) and that exact number + unit pair must be in our facts; a number without a known unit ("24 yards", "wait 3 days", "give or take 50"), a number word, a vague quantity ("a couple of gallons"), a price, or a missing headline number fails. On repair/replace and fit tasks the verdict sentence is ours, always first and never written by Spark; Spark only writes the next step, and its text may not contain a verdict word of either polarity, a negation or a comparison. Its text must also be in the customer's language. On a fail the template is kept. 6 s timeout, no retries | No: checked |

The page labels this honestly: **"Spark wording · numbers from geometry, checked"** (with **"en español"** only when Spark's text was detected as Spanish) when Spark's text passed the check, **"Numbers from geometry"** when the template was kept. Under the photo, a key lists SAM's masks with their confidence and what Spark said when it checked them. While the models work, the waiting steps follow real progress streamed from the server (one NDJSON line per finished step), and the reply's "How Meta's models measured it" panel shows each step's real output and timing. Failed calls show a short reason ("no reply in 6 s", "Meta's server had a hiccup (500)"), never a raw upstream error. A refused answer shows no number anywhere: not on the card, not on the photo, not in the panel (our math's steps say "measured, but not sent"); progress lines carry no step details.

### What the business gets

Every answer ends with a block for the business: job size, materials and a quote line, and a **Send this to <business>** button with an optional phone field (US numbers; set once, then locked). Tapping it creates a real lead on that business's owner board (`/owner.html?b=<id>`, channel "sight") and shows the customer a confirmation with a link to the board. The button sends only the answer's server-side id (kept for 2 hours) and the phone number, so what lands on the board is exactly what Sight measured.

Each chip goes to its own **demo business** with its own **demo price list** (`SIGHT_BUSINESSES` in `src/business.js`). These businesses and prices are made up for the demo, and every quote line says so:

| Chip | Demo business | Demo price list |
| --- | --- | --- |
| Tile floor | Cornerstone Tile & Floor (tile installer) | $8.50 per sq ft installed, $600 minimum |
| Windshield chip | ClearView Auto Glass | Chip repair $79; replacement $389 + $225 camera recalibration if needed |
| Shoe size | Stride Shoe Co. | Shoes from $89 a pair, free fitting |
| Shed fit | Backyard Shed Co. | Install $450 + gravel pad $6 per sq ft (only when the shed fits) |
| Driveway | Brightside Exterior Care | Sealing $0.30 per sq ft, $199 minimum |

For example: `420 sq ft × $0.30 per sq ft = $126; job minimum $199 (Brightside Exterior Care demo price list)`. A job that isn't on the receiving business's price list (a shed that won't fit, a tree height) still goes to the board, marked for the owner to price. Sight never invents a price.

On the owner board each Sight lead shows the measured headline, the job, the quote line, Muse Spark's verdict on SAM's masks (or **Unchecked** when its check didn't come back) and, with the owner key, the customer's photo with SAM's masks drawn on it.

## The five demo tasks

| Chip | The customer sends | They get | The business gets (on Send) |
| --- | --- | --- | --- |
| **Tile floor** | The floor with a sheet of printer paper on it | Floor size and sq ft, tiles to buy (+ waste), a centered layout and cut list | Sq ft, tile count, installed price |
| **Windshield chip** | The chip with a quarter beside it | Repair or replace (under a quarter / a 6 in crack), with the size and range | Repair or replacement price |
| **Shoe size** | A foot on a sheet of paper | Foot length, US men's / women's and EU size (with a note that some brands, like Nike, run small) | Size and width for a fitting |
| **Shed fit** | The side yard with a door in the shot | Narrowest and typical gap, fits / tight / won't fit for the shed width they typed | Gap, unit width, install price |
| **Driveway** | The driveway with the garage door at the far end | Sq ft with a range, size, sealer per coat (concrete gallons or asphalt pails) | Sq ft range, sealer, price |

Face measuring (card on the forehead) is in the code (`src/face.js`) but **off**: it is not in the demo, and a face request gets a polite "not available" reply. `SIGHT_FACE=1` turns it back on.

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

The numbers above come from synthetic scenes with known answers. Real-photo accuracy will be checked with the sample photos before judging.

**It refuses or asks again instead of guessing when:** Muse Spark looks at SAM's outlines and disagrees even after one correction round (or the coin is a different coin), there is no ruler in the shot, the ruler is partly hidden or bent, the thing runs off the edge of the photo, a coin is used for something much bigger than itself at an angle, a driveway photo has no garage or front door, the angle is too steep to find the horizon, or SAM can't find the target. Ruler-limit cases (a chip within measuring error of the repair limit) say so.

**Rate and access limits:** `/api/measure` and `/api/photo` allow 20 photos per 10 minutes per IP. The IP is the rightmost `X-Forwarded-For` entry, which Render's proxy appends (anything to its left was written by the caller), then the socket address. `cf-connecting-ip` / `true-client-ip` are ignored unless `TRUST_CLOUDFLARE=1` says the app really sits behind Cloudflare (otherwise anyone could rotate them to dodge the limit). A global cap on Meta calls per day (`META_DAILY_CAP`, default 1,500, reset at midnight UTC) counts every HTTP attempt to Meta, retries included (the SDK's own retries are off; ours are counted), so rotating IP addresses can't drain the credits; endpoints refuse up front when a request can't fit (a Sight photo reserves 12 calls: read, outlines, check, wording and one correction round). `/api/diag` model probes need `DIAG_TOKEN`. The public owner board is an allowlist: no phone numbers, addresses, names, message summaries, voicemail text, crew notes or photos (a text or voicemail lead shows only a label like "Voicemail lead · 0:42"); the full board needs `OWNER_TOKEN`, and a wrong key gets a notice instead of a silent public view.

## Privacy

- **What is sent where:** the customer's photo and message go from our server to Meta's Model API (Muse Spark and SAM 3.1) only to answer. **By default they pass through First Answer's relay**, a Supabase Edge Function (`relay/meta-relay.ts`) that forwards Meta API calls and stores nothing; it exists because Meta's API turns away some cloud hosts, Render among them. `META_RELAY_URL=direct` calls Meta directly. Meta's handling of what it receives is covered by Meta's terms.
- **What is kept:** nothing is written to disk. An answer is kept in memory for 2 hours so the customer can tap Send. A sent job (the measured job, the phone number if given, and a 480 px copy of the photo with SAM's masks drawn on it) stays on the owner board in memory until the server restarts. The page says this under the chat, and names the route (relay or direct) the server actually uses.

## Run it

```bash
npm install
npm test                         # 168 tests, no key needed, no Meta credits spent (fixtures and stand-ins)
npm start                        # http://localhost:3000/measure.html
MODEL_API_KEY=... npm start      # live on the Meta Model API
```

| Env var | What it does |
| --- | --- |
| `MODEL_API_KEY` | Meta Model API key (never sent to the browser) |
| `META_RELAY_URL` | Relay for hosts Meta's API turns away. Default: First Answer's Supabase relay. `direct` calls Meta directly |
| `TRUST_CLOUDFLARE` | `1` only when the app sits behind Cloudflare: then `cf-connecting-ip` / `true-client-ip` name the client for the rate limit |
| `SIGHT_FACE` | `1` turns face measuring back on (off by default) |
| `DIAG_TOKEN` | Unlocks `/api/diag` model probes (send as `x-diag-token`) |
| `OWNER_TOKEN` | Full owner board (with photos): open `/owner.html#key=...` (the part after `#` never reaches the server; the page sends it as the `x-owner-key` header and clears it from the address bar). Keys in the query string are ignored |
| `MEASURE_LIMIT` | Photos per 10 minutes per IP on `/api/measure` (default 20) |
| `PHOTO_LIMIT` | Photos per 10 minutes per IP on `/api/photo` (default 20, never more) |
| `META_DAILY_CAP` | Meta calls per day across all visitors (default 1500) |

**Sample photos:** put `public/samples/<id>.jpg` (or `.png`/`.webp`) with `public/samples/<id>.txt` beside it: first line is the chip label, the rest is the message sent with the photo. Ids: `tile`, `windshield`, `shoe`, `shed`, `driveway` (a `face` sample is listed only with `SIGHT_FACE=1`). A chip with a photo gets a glowing dot and sends the photo when tapped; the photos are served as static files from `/samples/`.

Node 22, Express, the OpenAI SDK pointed at the Meta Model API, `@meta-sam/parser` for SAM masks, `jpeg-js` for drawing SAM's outlines for Spark's check, `ws`, `multer`. Hosted on Render (`render.yaml`).

### Code map

- `src/anything.js`: the Sight flow (read, outline, measure, Spark's check of SAM, one correction round, word, business block) and the wording check.
- `src/overlay.js`, `src/overlay-worker.js`: draws SAM's masks onto the photo and crops close-ups for Spark's check (pure JS, in a worker thread), plus the owner board's small copy.
- `src/es.js`: Spanish for our template strings, and the language check on Spark's text.
- `src/flat.js`: close-up measuring next to an everyday ruler (homography, tilted coin), with ± ranges.
- `src/measure.js`: driveways and patios in square feet from a door's height and the ground's horizon.
- `src/distance.js`: camera pose from one photo; ground gaps, heights, distances with ranges.
- `src/face.js`: card-on-forehead face measurements (off unless `SIGHT_FACE=1`).
- `src/tiles.js`: tile layout and cut list. `src/rulers.js`: catalog of known-size objects.
- `src/muse.js`: Meta Model API client (Muse Spark chat, vision and multi-image check, SAM 3.1 by concept or by point, Muse Image, Muse Voice Transcribe); every HTTP attempt counts against the daily cap.
- `src/business.js`: the front-desk business (Brightside) and one demo business per Sight chip, with demo price lists.
- `src/guard.js`: per-IP rate limit (rightmost X-Forwarded-For), global daily Meta cap, token checks, owner-board redaction (allowlist).
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
| Oct 28 | Review pass 2 and judge fixes: locked verdict sentence and unit allowlist for Spark's wording; no numbers on refusals; public board without free text; overlay in a worker; counted retries; rightmost X-Forwarded-For; unchecked leads; Face off; Spark corrects SAM (one round); a demo business per chip; photo with masks on the owner board; Spanish cards; privacy note | `c0dbada`, `3a52295`, `fffa4e8`, `abc5589`, `df89f5a`, `5c03ee9`, `e512860`, `8d0939d`, `7ce5633`, `143d8b9`, `17c1695`, `59fc976` |

See `git log` for the full history.

## What existed before

- **First Answer, the company and the concept** (an AI front desk for local service businesses) existed before the hackathon. This codebase did not.
- **`first-answer-deposits`** is a separate, earlier repository (First Answer's PayPal hackathon entry). No code from it is in this repository.
- The **front-desk pages** (`public/index.html`, `public/owner.html`, `public/app.js`) were built on Oct 27, inside the window, as the agent flow Sight plugs into.

## License

MIT
