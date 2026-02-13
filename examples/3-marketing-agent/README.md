# Marketing Intelligence Agent (Scout)

A marketing intelligence agent that scrapes Twitter via [Apify](https://apify.com/apidojo/twitter-scraper-lite), analyzes the results with GPT-4o-mini, and produces actionable marketing intel for OpenSink's founder. Identifies comment opportunities, trending themes, new tools in the space, and tutorial ideas.

## How It Works

1. `POST /agent/run` triggers a full run
2. Fetches agent config from OpenSink (checks if enabled, reads keywords and maxItems)
3. Scrapes Twitter via the Apify [Twitter Scraper Lite](https://apify.com/apidojo/twitter-scraper-lite) actor for configured keywords
4. Filters out retweets, spam, and low-quality noise
5. Uses GPT-4o-mini to analyze the tweets and produce 4 outputs:
   - **Comment Opportunities** — high-engagement tweets where Dan could add value
   - **Trends** — recurring themes with sentiment analysis
   - **New Tools & Companies** — product launches and repos mentioned in the data
   - **Tutorial Ideas** — "Build X with OpenSink" content ideas based on what's trending
6. Stores each output category in its own OpenSink sink
7. Logs all activities to an OpenSink session
8. Returns a Telegram-formatted summary

## Setup

```bash
yarn install
cp .env.example .env
```

Fill in your `.env`:

```
PORT=3002
OPEN_SINK_API_KEY=your_open_sink_key
OPENAI_API_KEY=your_openai_key
APIFY_API_TOKEN=your_apify_api_token
```

### Getting API Keys

- **OpenSink** — generate an API key from your [OpenSink](https://opensink.com) dashboard
- **OpenAI** — create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Apify** — sign up at [apify.com](https://apify.com) and grab your API token from [Settings > Integrations](https://console.apify.com/settings/integrations). The agent uses the [apidojo/twitter-scraper-lite](https://apify.com/apidojo/twitter-scraper-lite) actor (event-based pricing).

### OpenSink Setup

Create these entities in your OpenSink dashboard, then update the IDs in `src/routes/index.ts`:

- 1 Agent
- 4 Sinks: Comment Opportunities, Trends, Tools & Companies, Tutorial Ideas

Set the agent configuration value to:

```json
{
  "enabled": true,
  "keywords": ["ai agents", "agent framework", "agent memory", "agent observability", "llm agents", "ai agent production", "mcp server"],
  "maxItems": 200
}
```

| Config field | Type | Description |
|---|---|---|
| `enabled` | `boolean` | Toggle the agent on/off |
| `keywords` | `string[]` | Twitter search keywords to scrape |
| `maxItems` | `number` | Max tweets to scrape per run (default 200) |

## Running

```bash
# Development (hot reload)
yarn dev

# Production
yarn build
yarn start
```

## API

`POST /agent/run` — scrapes tweets, analyzes them, and returns an intelligence report. No request body needed — all configuration comes from OpenSink.

### Response

Returns the full structured analysis, run stats, and a `telegram_message` field with a pre-formatted plain-text summary ready for Telegram delivery.

```json
{
  "success": true,
  "stats": {
    "tweetsScraped": 200,
    "tweetsAnalyzed": 147,
    "commentOpportunities": 10,
    "trends": 5,
    "newTools": 3,
    "tutorialIdeas": 3
  },
  "analysis": { "..." },
  "telegram_message": "--- SCOUT MARKETING INTEL ---\n..."
}
```
