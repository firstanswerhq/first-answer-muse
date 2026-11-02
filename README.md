# First Answer Sight

**See it. Size it. Solve it.** A customer texts one photo to a local business, with something of known size in the shot (a quarter, a sheet of paper, the garage door). The customer gets the measurement, what to buy and what to do next, in English or Spanish (a Spanish question gets the whole card in Spanish). One tap on **Send this to the business** sends the business a lead with the job size, the materials, a quote line from its own price list, and the photo with the measured objects outlined.

Built on Meta's models for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026), Startups track. Sight is the photo step of **First Answer**, the AI front desk that answers every text, photo, voicemail and call for a small service business.

**Who did what.** Meta's Muse Spark (a vision and language model) reads the photo and checks the outlines. Meta's SAM 3.1 (Segment Anything, which outlines objects in a photo) draws them. Everything else is ours: the measuring math, the tile and sealer rules, the quote line and the owner's board.

**Accuracy so far, honestly.** On two tape-measured real floors the true area landed inside the stated range both times: a real bathroom (private photos, not in this repo) read 6–9% low (wide ranges, about 155–232 sq ft) and a small elevator floor read 0.7% high (22.4 sq ft against a true 22.25, range 21–24). Surfaces and gaps are weaker: a real driveway read 15–20% low, a real 6 × 6 ft concrete stoop read about 44% low, and a side-yard gap read about a third of its walked width. We are fixing those. The stoop and gap results are field observations with no test behind them yet. Apart from the shoe photo described below, every other accuracy number comes from computer-rendered test scenes, not real photos. Treat an answer as a first estimate, not a final quote. For tile, the order is sized on the high end of the range so a customer isn't left short.

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
| Word the answer | **Muse Spark 1.3** | Writes the answer and next step from our numbers only. `checkWording()` is an allowlist: every number in Spark's text must carry a unit we know (sq ft, gallons, pails, in, ft, mm, cm, tiles, %, hours, °F, US/EU, men's/women's, in English and Spanish) and that exact number + unit pair must be in our facts; a number without a known unit ("24 yards", "wait 3 days", "give or take 50"), a number word, a vague quantity ("a couple of gallons"), a price, or a missing headline number fails. On repair/replace and fit tasks the verdict sentence is ours, always first and never written by Spark; Spark only writes the next step, and its text may not contain a verdict word of either polarity, a negation or a comparison. Its text must also be in the customer's language. On a fail the template is kept. 6 s timeout, no retries. Spark's reasoning tokens share its output budget (1,500 now; at 600 the tile task's long facts left it no room to write, and the panel said "kept our template (empty)"); the call asks for the least thinking (`reasoning_effort: minimal`, falling back to `low` if the endpoint refuses it); when it returns no text the panel says "Spark returned no text" | No: checked |

The page labels this honestly: **"Spark wording · numbers from geometry, checked"** (with **"en español"** only when Spark's text was detected as Spanish) when Spark's text passed the check, **"Numbers from geometry"** when the template was kept. Under the photo, a key lists SAM's masks with their confidence and what Spark said when it checked them. While the models work, the waiting steps follow real progress streamed from the server (one NDJSON line per finished step), and the reply's "How Meta's models measured it" panel shows each step's real output and timing. Failed calls show a short reason ("no reply in 6 s", "Meta's server had a hiccup (500)"), never a raw upstream error. A refused answer shows no number anywhere: not on the card, not on the photo, not in the panel (our math's steps say "measured, but not sent"); progress lines carry no step details.

### Whole floor from several photos

One photo from a doorway sees only part of a floor. So the customer lays **one** sheet of printer paper on the floor, square to a wall, leaves it there, and takes 2 to 4 photos from different doorways or corners, with the paper in every shot. It works the way texting works:

1. The customer sends one floor photo. If SAM's floor outline sits wholly inside the photo (no edge touched), they get the tile answer as always. If the floor runs off the photo's edge, as it does in most doorway shots where the near tiles run under the camera, they get what it shows and a request: **"I can see part of the floor: about 61 sq ft so far. Send one or two more photos from another doorway or corner, and leave the sheet of paper where it is, so I can measure the whole room."** No tiles to buy and no job for the business yet.
2. Each later photo in the same conversation is combined with the earlier ones (the page keeps this conversation's floor photos and sends them all each time; the server stays stateless): **"Combined from 2 photos: the floor is about 10 ft 2 in by 12 ft 1 in (123 sq ft). In 12 × 12 in tile that's 132 tiles laid. To be safe the order covers the high end of the range (138 sq ft), plus 15% extra for cuts and mistakes: buy 172 tiles. Send one more if a corner is still missing, or tap Send to the business."** Up to 4 photos; at 4: "That's the limit of 4 photos; tap Send to the business."
3. A photo that can't be used is dropped, the good ones still answer, and the tip names it: **"Photo 2: I can't line that one up without the paper. Send it again with the whole sheet in the shot (and leave the sheet where it is)."** A sheet too small or too far to read: **"Photo 2: Get closer to the sheet for that one and send it again."** No floor found: "Photo 2: I couldn't find the floor in that one. Send it again with more of the floor and the whole sheet in the shot."
4. The set of floor photos resets when the customer moves to another task, taps **Start over** under the answer, or sends the job to the business. "Add another photo of the same floor" on the staged bar still attaches several at once as a shortcut.

- **Per photo**, the same pipeline as one photo: SAM 3.1 outlines the floor and the paper, and Muse Spark checks both outlines (one check per photo; the panel says "photo 2 of 3: ..."). The checks share one budget of 10 s plus 6 s per further photo (at most 30 s) and run two at a time, each with its own overlay drawing; on the first live run all the checks ran at once and all timed out at 10 s together.
- **The paper anchors every photo.** Each photo's paper gives a perspective map from that photo's pixels to millimeters on the paper's plane, with the paper's corner as the origin and its long edge as the x axis (`src/flat.js`, the same map the one-photo case uses). Every photo's floor lands in that one frame, so the floors can be laid over each other without knowing where the phone was.
- **Which edge of the paper is the long one.** Four corners alone can't say: the edge pointing away from the camera is foreshortened, and from about 40° down a letter sheet's long edge can look shorter than its short edge. So both rectangles are tried and the camera decides: with the phone's focal length (from the photo's EXIF, else a typical phone), the true rectangle's map has the plane's two axes orthogonal and of equal length as the camera sees them; the wrong one stretches an axis by the paper's 1.29 aspect. The same fit score replaces the old pixel-ratio "ruler shape looks off" test, so a sheet seen at a steep angle is no longer called bent. The one-photo answers get the right sides from this too.
- **Combine** (`src/floor.js`): the floors are unioned on a grid of 25 mm cells (each cell center is mapped back into each photo and asked "is this inside SAM's floor mask?"). Because the paper is square to a wall, the frame's axes are the walls: the union's bounding rectangle is the room (width × length), and the tile plan comes from that rectangle as it does for one photo. **The limit of that:** anything SAM includes in the floor mask widens the rectangle: a doorway strip or hallway floor 1 m deep across a 0.9 m door adds that depth across the whole width (123 sq ft seen became a 130 sq ft rectangle in a probe). The panel's combine step shows the floor actually seen in sq ft, how much of the rectangle it fills, and how much any two photos' floors overlap.
- **Real floors are not rectangles.** The first live run, on the two AI-generated bathroom samples we had at the time, had the union fill 78% of its rectangle (the vanity and the tub take bites) and the old rule refused it. Now there are three bands on fill: **95% and up**, a plain rectangle, and the rectangle's area is the floor (rendered plain rooms fill 97–100%; at a 90% line a vanity worth a tenth of the floor was being folded into "a plain rectangle", 11% high); **55% to 95%**, a real floor with fixtures in it: the answer gives the room's sides for the layout and the **union's own area as the floor to tile** ("the room is about 7 ft 4 in by 9 ft 10 in; the floor to tile is 59 sq ft (the floor isn't a plain rectangle: a vanity, tub or toilet takes up part of it)"), tiles laid are the rectangle plan's count (full tiles plus one per cut piece) scaled by the open share so the count and the cut list agree, and the steps say the cut list is for the open floor; **under 55%**, refused. Honestly: these thresholds were tuned on one bathroom pair (AI-generated demo images, see the samples note below) and the rendered rooms in `test/floor.test.js`; the 55% floor is a guess at where fixtures end and misalignment begins, and more real floors will move it.
- **Did the photos reach the walls?** The floor's last cell in each row and column is where the floor ends; if some photo's frame reaches past it, that end is a wall a photo saw. A side where fewer than 40% of those ends have a photo looking past them is **open**: the floor just ran out of the photos there (two shots from opposite doorways, both aimed down the middle, clip the same two side ends and would otherwise read a 14 ft room as 11 to 13 ft). An open side keeps the answer a partial: "I can see about 78 sq ft of the floor so far, combined from 2 photos, but no photo shows where the floor ends on every side. Send a photo from the end of the room the others didn't reach…", no tiles and no job yet.
- **The 180° question.** Once the long edge is right, the paper's long edge is x in every photo and the map keeps handedness (the phone is above the floor), so the only way two photos' frames can disagree is a half turn about the paper. Overlap alone cannot settle it (a photo from the opposite end overlaps the first well either way round), so the turn is chosen by **contradiction**: floor in this photo where an earlier photo, looking straight at that spot, saw none (a wall out of place). A wrong turn moves a wall by twice the sheet's distance from the room's center line and lights that up; the right turn reads near zero. When both turns contradict about equally (the sheet within a few centimeters of the center line) and the other turn would change the room's long side by more than 10%, the answer's range spans both readings, confidence drops to rough, and the tip says: "Two photos from opposite ends can't always tell which way is which; a third photo from a side wall settles it." The 40% pairwise-overlap check is a different guard: it catches a sheet that moved or a photo of another floor, not a wrong turn.
- **Range:** each photo's error is worked out from its sheet: the floor is extrapolated meters past a sheet a hundred pixels wide, so each of the sheet's four corners is nudged a third of a pixel (what a straight-line fit through the mask's edge pixels is good to), the map rebuilt, the floor's extent on the plane re-measured, and the four corners' shifts added in quadrature; the combined range is the widest photo's, doubled for area. A sheet near a wall or in a corner widens the range: more of the floor lies far from it. The panel shows each photo's far-wall error in inches. A floor that runs off a photo's edge is normal here and does not widen the range as it does for one photo (where it adds 8%).
- **When the sheet is too small to read.** Across a sweep of 1,857 rendered poses the long-edge choice was wrong for 0% of sheets 90 px or more across their short side, 1% at 60–90 px, 6% at 40–60 px and 10% under 40 px (with the phone's typical focal length; about half that with the true one). So a sheet whose fitted short side is under 55 px (the sweep's 60 px on SAM's box), or whose two candidate scores are within 0.1 of each other, is called rough for one photo and asked for again in a multi-photo floor; a sheet whose fit score is over 0.25 (partly hidden, bent, or the wrong thing) likewise. Of the sweep's photos that pass those gates, 1 in about 2,700 picked the wrong edge. The cost: a sheet 3.8 m from a doorway at 1600 px is about 85 × 50 px, so a far sheet seen from a steep doorway angle is a retake ("get closer to it").
- **It drops a photo, or refuses, when:** the sheet is not found in a photo, is too small or too far to read (its map would blow the floor up), or the floor is not found: that photo is **dropped** and asked for again by number ("Photo 2: I can't line that one up without the paper…", "Photo 2: Get closer to the sheet for that one and send it again."), and the other photos still answer, with their numbers in the panel; only when no photo is usable does the request fail, and then no number shows anywhere, the panel included ("measured, but not sent: a photo needs a retake"). Muse Spark disagrees with SAM in any photo: the whole answer is refused, the tip names the photo, no number shows (no correction round across photos). A photo's floor more than about a meter from the floor in the other photos (probably not the same floor, or the paper moved), two photos' floors overlapping by less than 40% of the smaller one (a photo did not line up), or a union filling less than 55% of its rectangle: the combined number is refused and the best single photo (the finest map at the sheet, never the biggest floor) answers, with a note saying why; when that photo shows only part of the floor, the answer is its partial ("so far"), never the room, and at the 4-photo limit it says to start over rather than asking for more; the panel still shows each photo's floor seen. Several photos with a question that isn't about a floor: the first photo is measured and the note says so.

`/api/measure` takes `dataUrls` (1 to 4; `dataUrl` alone still works). Each distinct photo counts once against the per-IP limit per 10 minutes (photos are told apart by a hash of their content, so a conversation that re-sends its earlier photos with each new one costs one hit per photo, four for a four-photo floor) and every photo in a request reserves 12 Meta calls against the daily cap (the earlier photos are outlined again each time: the server keeps nothing).

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
| **Tile floor** | The floor with a sheet of printer paper on it: one photo if it shows the whole floor; otherwise more photos from other doorways as the answer asks, one at a time, with the same sheet left in place (up to 4; **Add another photo of the same floor** attaches several at once) | Floor size and sq ft, tiles to buy (+ waste), a centered layout and cut list; from several photos, the whole floor combined on the paper's plane, every photo shown with SAM's masks | Sq ft, tile count, installed price |
| **Windshield chip** | The chip with a quarter beside it | Repair or replace (under a quarter / a 6 in crack), with the size and range | Repair or replacement price |
| **Shoe size** | A foot next to or on a sheet of paper | Foot length, US men's / women's and EU size (with a note that some brands, like Nike, run small) | Size and width for a fitting |
| **Shed fit** (no sample photo yet) | The side yard with a door in the shot | Narrowest and typical gap, fits / tight / won't fit for the shed width they typed. Early test: a real side-yard gap read about a third of its walked width, so treat this one as experimental | Gap, unit width, install price |
| **Driveway** | The driveway with the garage door at the far end | Sq ft with a range, size, sealer per coat (concrete gallons or asphalt pails) | Sq ft range, sealer, price |

Face measuring (card on the forehead) is in the code (`src/face.js`) but **off**: it is not in the demo, and a face request gets a polite "not available" reply. `SIGHT_FACE=1` turns it back on.

## Accuracy and limits

Every answer says what it was measured against, for example **Measured against: quarter (24.26 mm)** or **double garage door (16 × 7 ft)**, and carries a range or a confidence.

| Task | Range shown | Tested against (rendered scenes, not real photos, unless noted) |
| --- | --- | --- |
| Close-up with paper, card, bill or plate | ±3% of the length (never finer than about 1.5 pixels at the target) | Rendered scenes with known sizes at angles up to 35° (`test/flat.test.js`, `test/anything.test.js`, `test/trust.test.js`) |
| Close-up with a coin | ±4%, ±6% when the coin is seen at more than 30° | Same |
| Any close-up marked "Rough" | +8% on top of the above | Same |
| Tile floor area | twice the length range (area) | Rendered 12 × 10 ft floor, within 7% |
| Whole floor from several photos | twice the widest photo's propagated error (from a third of a pixel on the sheet's corners); never under ±6% | Rendered rooms in `test/floor.test.js`: a 10 × 12 ft room from three partial photos (two doorways and a corner, each seeing 86–90%) and from four (a fourth at pan 70°), with the paper square to the wall both ways at tilt 35°: area within 8%, each side within 5% (120–126 sq ft, ranges about ±12–14%); an 11 × 9 ft room with the sheet 200 mm from a corner, three doorway shots at tilt 42–50°: 99–101 sq ft, and the truth inside the range every time (ranges ±16–22%). A 3 × 2.2 m room with a 1.2 × 0.9 m vanity block, two doorway shots: the union fills about 80% of the rectangle and the floor to tile comes out within 10% of the 59 sq ft of open floor. A 6.6 × 14.1 ft room (93 sq ft) shot from its two end doorways with the sheet near the center line: the two frames clip the same side ends, the union is 64–90 sq ft, and the answer is a partial asking for a photo from the missing end (before this it read "6 ft 8 in × 10 ft 11 in" as the room). Refused as retakes, never measured: the same rooms shot at 55–60° (the far sheet 42 px tall) and Review A's 8 × 14 ft room with the sheet 300 mm from the far wall (45 px; it used to deliver 186–189 sq ft for 112). The wrong-edge sweep above |
| Driveway / patio | ±25% when the geometry checks out (card says "Close estimate"), ±30% when it doesn't | Rendered driveways 432 and 1,500 sq ft, within 12–15%; steep side angles are never marked good (`test/measure.test.js`, `test/surface.test.js`) |
| Ground gap, height, distance | low–high range from the camera pose spread | Rendered 3D yards (`test/distance.test.js`) |

The numbers above come from synthetic scenes with known answers. On real photos we have two tape-measured floors so far. The first is a room of 12 ft 1 in × 17 ft 8 in with a closet and a tub (true floor 199.8 sq ft: closet excluded, tub ignored). Two runs, one sheet of printer paper that did not move: four photos gave 187.2 sq ft (6.3% under) and three photos gave 182.7 sq ft (8.6% under). The true area was inside the stated range both times (155–232 and 162–203 sq ft). The reported room sides were 7–15% too large, so treat the area as the answer and the sides as rough. A second real floor, a small elevator (an L-shaped floor of 36 × 47 in plus 36 × 42 in, true area 22.25 sq ft, sketched and tape-measured), read 22.4 sq ft from three photos with one sheet of paper that did not move (range 21–24); a fourth photo was refused because the paper could not be found in it. One real driveway (a flared concrete slab, photographed straight on, sized by walking it off heel to toe, not with a tape) read about 15–20% low and landed outside its original ±12% range, so driveway ranges are now ±25% and the card says "Close estimate." The two room runs are the same room, so they are not independent tests: in this room the area came in under, by 6–9%, and one room is not enough to say how typical that is.

**It refuses or asks again instead of guessing when:** Muse Spark looks at SAM's outlines and disagrees even after one correction round (or the coin is a different coin), there is no ruler in the shot, the ruler is partly hidden or bent, the thing runs off the edge of the photo, a coin is used for something much bigger than itself at an angle, a driveway photo has no garage or front door, the angle is too steep to find the horizon, or SAM can't find the target. Ruler-limit cases (a chip within measuring error of the repair limit) say so.

**Rate and access limits:** `/api/measure` and `/api/photo` allow 20 photos per 10 minutes per IP. The IP is the rightmost `X-Forwarded-For` entry, which Render's proxy appends (anything to its left was written by the caller), then the socket address. `cf-connecting-ip` / `true-client-ip` are ignored unless `TRUST_CLOUDFLARE=1` says the app really sits behind Cloudflare (otherwise anyone could rotate them to dodge the limit). A global cap on Meta calls per day (`META_DAILY_CAP`, default 1,500, reset at midnight UTC) counts every HTTP attempt to Meta, retries included (the SDK's own retries are off; ours are counted), so rotating IP addresses can't drain the credits; endpoints refuse up front when a request can't fit (a Sight photo reserves 12 calls: read, outlines, check, wording and one correction round; a floor sent as several photos reserves 12 per photo; against the per-IP limit each distinct photo counts once per 10 minutes, by a hash of its content, so re-sending the earlier photos of a floor is free). `/api/diag` model probes need `DIAG_TOKEN`. The public owner board is an allowlist: no phone numbers, addresses, names, message summaries, voicemail text, crew notes or photos (a text or voicemail lead shows only a label like "Voicemail lead · 0:42"); the full board needs `OWNER_TOKEN`, and a wrong key gets a notice instead of a silent public view.

## Privacy

- **What is sent where:** the customer's photo (or photos, for a floor) and message go from our server to Meta's Model API (Muse Spark and SAM 3.1) only to answer. **By default they pass through First Answer's relay**, a Supabase Edge Function (`relay/meta-relay.ts`) that forwards Meta API calls and stores nothing; it exists because Meta's API turns away some cloud hosts, Render among them. `META_RELAY_URL=direct` calls Meta directly. Meta's handling of what it receives is covered by Meta's terms.
- **What is kept:** nothing is written to disk. An answer is kept in memory for 2 hours so the customer can tap Send. A sent job (the measured job, the phone number if given, and a 480 px copy of the first photo with SAM's masks drawn on it) stays on the owner board in memory until the server restarts. The page says this under the chat, and names the route (relay or direct) the server actually uses.

### Try the whole-floor measure in 60 seconds

1. Open `/measure.html` and tap **Tile floor**. The first photo (a real elevator floor, shot from the doorway, one sheet of paper on the floor) is sent with the question.
2. The reply shows the photo with SAM's masks, "About N sq ft so far" and the request for another photo from another doorway, with a **Send the next sample photo** button under it (and **Start over**).
3. Tap it. The second photo (the same elevator floor from another angle) goes with the first; the waiting list shows SAM outlining the floor and the paper in each photo ("1 of 2 done", "2 of 2 done"), our geometry mapping each floor onto the paper's plane and combining them, then Muse Spark checking every photo's outlines.
4. The reply shows photo 1 full size and photo 2 under it, each with SAM's masks, then "Combined from 2 photos: the floor is about W by L (N sq ft) ... buy N tiles. Send one more if a corner is still missing, or tap Send to the business", the business block, and the panel's combine step with the floor seen, how much of a rectangle it fills and each photo's coverage.
5. With your own floor: lay one sheet of printer paper on it square to a wall, send a photo from one doorway with a question about the floor, then, when the answer asks, tap the camera and send the next photo from another doorway (nothing to type; up to 4), leaving the paper where it is. Each joins the earlier ones. A photo without the sheet is dropped and asked for again; the others stay.

## Run it

```bash
npm install
npm test                         # 211 tests, no key needed, no Meta credits spent (fixtures and stand-ins; test/page.test.js drives the page in headless Chromium when Playwright is installed, else skips)
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

**Sample photos:** `public/samples/<id>.jpg` (or `.png`/`.webp`) with `public/samples/<id>.txt` beside it: first line is the chip label, the rest is the message sent with the photo. Ids: `tile`, `windshield`, `shoe`, `driveway` (a `face` sample is listed only with `SIGHT_FACE=1`). A chip can have several photos: `tile.jpg`, `tile-2.jpg`, `tile-3.jpg` ... are one sample, staged in that order. A chip with a photo gets a glowing dot; tapping it sends the photo (the Tile floor chip stages its photos first, so more can be added before Send). The photos are served as static files from `/samples/`.

The samples in `public/samples/` are a mix, labeled honestly. **Real photos:** the three tile photos below, and `shoe.jpg` is the author's own foot on a sheet of printer paper (foot 11.0 in with a tape; Sight reads about 10.25 in on this photo because the heel is hidden by the leg, so a cleaner shot is planned). `tile.jpg`, `tile-2.jpg` and `tile-3.jpg` are real photos of one elevator floor with one letter sheet on it (true floor 22.25 sq ft, measured by the author with a tape). **AI-generated demo images, to be replaced with real photos:** `windshield.jpg` (a chip with a quarter) and `driveway.jpg` (a driveway with a double garage door). Measurements on generated images show the pipeline end to end, but a generated room has no true size to check against; the accuracy numbers above come from the rendered test scenes, plus the one tape-measured room described there.

Node 22, Express, the OpenAI SDK pointed at the Meta Model API, `@meta-sam/parser` for SAM masks, `jpeg-js` for drawing SAM's outlines for Spark's check, `ws`, `multer`. Hosted on Render (`render.yaml`).

### Code map

- `src/anything.js`: the Sight flow (read, outline, measure, Spark's check of SAM, one correction round, word, business block) and the wording check.
- `src/overlay.js`, `src/overlay-worker.js`: draws SAM's masks onto the photo and crops close-ups for Spark's check (pure JS, in a worker thread), plus the owner board's small copy.
- `src/es.js`: Spanish for our template strings, and the language check on Spark's text.
- `src/flat.js`: close-up measuring next to an everyday ruler (homography, tilted coin), with ± ranges.
- `src/floor.js`: whole floor from several photos: each photo's floor mapped onto the paper's plane, the 180° rule, the 25 mm grid union and the refusal rules.
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
| Oct 27 | Model access diagnostics (`/api/diag`) | `579df0b`, `06b17bc` |
| Oct 28 | Model access diagnostics, continued (`/api/diag`) | `73bd06c`, `98b5f92` |
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
| Oct 28 | Privacy: README and page name the Supabase relay route and what is kept in memory | `44b43c8` |
| Oct 28 | Tile answer passes our own unit check; every chip's template is tested | `5a171ee` |
| Oct 28 | Hundredths under an inch; owner gets the job in English for Spanish questions; Spanish outline labels | `0eaf815` |
| Nov 1 | Whole floor from several photos: 2 to 4 photos of one floor with the same sheet of paper combined on the paper's plane (`src/floor.js`), per-photo steps and checks, retake and different-floor refusals, `dataUrls` on `/api/measure` with per-photo limits, the page's "Add another photo of the same floor", Spanish, tests | `8f438dc`, `9c4d81e`, `b5143b3`, `4b3f65e`, `2c833ab`, `4a3c7cc`, `3d41482` |
| Nov 1 | Review fixes: the paper's long edge chosen with the camera (focal length), not pixel length; per-photo sanity bounds; rectangle-fill check; refused answers withhold every panel number; page never wipes staged photos, per-thumbnail ×, pins stay inside the photo; JSON 413; sample chips with several photos; README honesty on the rectangle limit and the half-turn claim | `23b9afe`, `a0246ec`, `7486132`, `246408f`, `f5570ce`, `6312a1b` (and this hash-only commit) |
| Nov 1 | Verification fixes: a sheet too small to read is a retake (fit, score margin, 55 px), the fallback photo is the finest map, each photo's range is propagated from its sheet's corners, panel says 'a photo needs a retake'; page grid span, kept-first line, 24 px ×; README accuracy from the wrong-edge sweep, build-table dates | `9ff7ce2`, `d832155`, `0cf00ed` (and one hash-only commit) |
| Nov 1 | The floor as a conversation: one photo gives "so far" and asks for more, each later photo is combined, bad photos are dropped and asked for again, "Send the next sample photo" and "Start over" on the page | `c73c559`, `c2b7805`, `d2361ff`, `7d386b1` |
| Nov 1 | Sample photos: the bathroom from its two ends, a windshield chip, a side yard, a driveway (AI-generated demo images; the tile sample was later replaced with real elevator-floor photos) | `9fe3aa2` |
| Nov 1 | Review D fixes: a camera photo sent with nothing typed joins the floor; the 5th photo is stopped on the page; dropped photos badged and named under the answer; each distinct photo counts once per 10 minutes against the per-IP limit; Playwright page test; README | `749fcfe`, `a019ae2`, `a5bb9a9`, `37e2bdd` (and one hash-only commit) |
| Nov 1 | After the first live run: fill bands (a floor with fixtures combines with the open floor as the tile area; under 55% refused), a 40% pairwise-overlap alignment check, a shared two-at-a-time budget for Spark's checks, the partial as the fallback after a refused combine, Spark's wording token budget raised and an honest panel line when it returns no text | `d0ce8dd` (and one hash-only commit) |
| Nov 1 | Review E: tiles laid agree with the cut list on an open floor; the half turn chosen by contradiction, with a spanned range and a note when it is a guess; open sides (no photo reaches the wall) keep the answer a partial; RECT_FILL 0.95; the partial fallback at the limit; Spanish for the new notes; `reasoning_effort: minimal` for the wording | `0a72a1e` (and one hash-only commit) |

See `git log` for the full history.

## What existed before

- **First Answer, the company and the concept** (an AI front desk for local service businesses) existed before the hackathon. This codebase did not.
- **`first-answer-deposits`** is a separate, earlier repository (First Answer's PayPal hackathon entry). No code from it is in this repository.
- The **front-desk pages** (`public/index.html`, `public/owner.html`, `public/app.js`) were built on Oct 27, inside the window, as the agent flow Sight plugs into.

## License

MIT
