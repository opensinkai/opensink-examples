# Finance News Agent (Fastify)

A financial news agent that fetches articles from NewsAPI, uses OpenAI to analyze and categorize them, and stores the results in an OpenSink sink.

## How It Works

1. Fetches agent config from OpenSink (checks if enabled, how many items to fetch)
2. Pulls financial news from NewsAPI (last 24 hours)
3. Uses GPT-4o-mini to pick top articles and categorize them (stocks, crypto, economy, etc.)
4. Stores selected articles in an OpenSink sink
5. Logs all activities to an OpenSink session

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

`POST /agent/run` — triggers the agent to fetch and analyze news.
