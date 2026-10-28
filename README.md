# First Answer on Meta Muse

**When a plumber misses a call, the customer calls the next plumber.** First Answer is the front desk a small service business can't afford to hire: it answers every text, photo, voicemail and phone call in seconds, quotes the job from the business's real price list, and books it on the real calendar. This version runs entirely on Meta's models.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 27 - Nov 4, 2026), Startups track.

## What it does

The demo business is **Brightside Exterior Care**, a window cleaning, pressure washing and gutter company in Nashville.

| The customer... | What happens | Meta model |
| --- | --- | --- |
| **Texts** "how much for my windows?" | The agent asks for a count or a photo, quotes from the price list, offers real open times, books it | **Muse Spark 1.3** with tool calling |
| **Texts a photo** of their house | Muse Spark reads the photo (which job, how big, anything the crew should know). SAM 3.1 finds every window and the quote is a real count, not a guess. Muse Image sends back an "after" picture of *their* house, cleaned | **Muse Spark** vision + **SAM 3.1** + **Muse Image** |
| **Leaves a voicemail** at 2 AM | Transcribed, understood, and texted back with a quote and open times within seconds | **Muse Voice Transcribe** + **Muse Spark** |
| **Calls** | Live captions as they talk; every finished sentence goes to the agent, which answers out loud | **Muse Voice Transcribe** realtime + **Muse Spark** |

The owner watches it all on one page (`/owner.html`): every lead, from every channel, with the quote, the crew notes from the photo, the voicemail transcript and the booking.

## Why it can be trusted with a business

The model never makes up a number. Prices, job lengths and open times come only from the booking engine (`src/engine.js`), and the agent can reach them only through tools (`quote_job`, `open_times`, `book_job`). A booking is refused unless the time was actually open and the customer gave a name and address. SAM's count goes into the same price list a human would use.

## Run it

```bash
npm install
npm test                         # 11 tests, no key needed
npm start                        # http://localhost:3000
MODEL_API_KEY=... npm start      # live on Meta Model API
```

Without a key, a small scripted brain calls the same tools so the text, photo and voicemail flows can be tried end to end. Live calls, the photo count, the "after" picture and real transcription need the key.

## How it's built

- `src/muse.js`: Meta Model API client (base URL `https://api.meta.ai/v1`). Chat Completions with tools and JSON-schema output for Muse Spark; the Responses API for SAM 3.1; `/images/edits` for Muse Image; `/asr/transcribe` and the realtime WebSocket for Muse Voice Transcribe.
- `src/agent.js`: the front-desk agent loop and its tools.
- `src/photo.js`: photo to quote (read, count, price, after picture).
- `src/engine.js`: price list, calendar and bookings in the business's own time zone.
- `src/server.js`: Express API, owner live feed (server-sent events), live-call relay (WebSocket; the API key never reaches the browser).
- `public/`: the customer phone and the owner board. The browser records 24 kHz 16-bit PCM itself, the format Muse Voice Transcribe takes.

Node 22, Express, the OpenAI SDK pointed at Meta Model API, `ws`, `multer`. Hosted on Render (`render.yaml`).

## New work

Everything in this repository was written during the hackathon, starting Oct 27, 2026. First Answer, the company, existed before; this codebase did not. See the commit history.

## License

MIT
