# Trading Agent (Fastify)

A trading agent with a human-in-the-loop approval workflow. Fetches financial news, proposes trades using OpenAI, waits for human approval, then executes approved trades.

## How It Works

1. **Analyze** — fetches financial news from NewsAPI and categorizes with GPT-4o-mini
2. **Propose** — AI proposes 3-5 trades based on news sentiment
3. **Await Approval** — creates an input request for human review
4. **Execute** — runs approved trades and records them in an OpenSink sink

## Setup

```bash
npm install
cp .env.example .env
```

Fill in your `.env`:

```
PORT=3000
OPEN_SINK_API_KEY=your_open_sink_key
NEWSAPI_KEY=your_newsapi_key
OPENAI_API_KEY=your_openai_key
```

### Getting API Keys

- **OpenSink** — generate an API key from your [OpenSink](https://opensink.com) dashboard
- **NewsAPI** — sign up at [newsapi.org](https://newsapi.org) for a free key
- **OpenAI** — create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

## Running

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

## API

**Start a new workflow:**

```
POST /agent/run
```

Returns a `sessionId` and `inputRequestId`.

**Execute after approval:**

```
POST /agent/run
Headers:
  x-opensink-session-id: <sessionId>
  x-opensink-request-id: <inputRequestId>
```

Executes trades that were approved in the OpenSink UI.
