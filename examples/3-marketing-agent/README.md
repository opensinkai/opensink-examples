# Marketing Intelligence Agent (Scout)

A configurable marketing intelligence agent that scrapes Twitter via [Apify](https://apify.com/apidojo/twitter-scraper-lite), analyzes the results with GPT-4o-mini, and produces actionable marketing intel. Identifies comment opportunities, trending themes, new tools in the space, and tutorial ideas.

**Fully configurable** — set up for your own company by providing your company info, founder context, and custom instructions via OpenSink agent configuration. No code changes required.

## How It Works

1. `POST /agent/run` triggers a full run
2. Fetches agent config from OpenSink (company info, founder context, keywords, sink IDs)
3. Scrapes Twitter via the Apify [Twitter Scraper Lite](https://apify.com/apidojo/twitter-scraper-lite) actor for configured keywords
4. Filters out retweets, spam, and low-quality noise
5. Uses GPT-4o-mini to analyze the tweets and produce 4 outputs:
   - **Comment Opportunities** — high-engagement tweets where you could add value
   - **Trends** — recurring themes with sentiment analysis
   - **New Tools & Companies** — product launches and repos mentioned in the data
   - **Tutorial Ideas** — "Build X with [YourProduct]" content ideas based on what's trending
6. Stores each output category in its own OpenSink sink (with resources linking to source tweets)
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
AGENT_ID=your_agent_id
OPEN_SINK_API_KEY=your_open_sink_key
OPENAI_API_KEY=your_openai_key
APIFY_API_TOKEN=your_apify_api_token
```

### Getting API Keys

- **OpenSink** — generate an API key from your [OpenSink](https://opensink.com) dashboard
- **OpenAI** — create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Apify** — sign up at [apify.com](https://apify.com) and grab your API token from [Settings > Integrations](https://console.apify.com/settings/integrations). The agent uses the [apidojo/twitter-scraper-lite](https://apify.com/apidojo/twitter-scraper-lite) actor (event-based pricing).

### OpenSink Setup

Create these entities in your OpenSink dashboard:

- 1 Agent (set the ID in your `.env` as `AGENT_ID`)
- 4 Sinks: Comment Opportunities, Trends, Tools & Companies, Tutorial Ideas

Set the agent configuration value (JSON):

```json
{
  "enabled": true,
  "keywords": ["ai agents", "agent framework", "your product keywords"],
  "maxItems": 200,
  "companyName": "YourCompany",
  "companyWebsite": "yourcompany.com",
  "companyDescription": "YourCompany is [what your product does]. It provides [key features]. It's [stage/positioning].",
  "founderName": "Your Name",
  "founderContext": "- Solo founder at early stage.\n- Low social media following. Strategy: comment on high-traffic posts rather than posting into the void.",
  "sinks": {
    "opportunities": "uuid-of-opportunities-sink",
    "trends": "uuid-of-trends-sink",
    "tools": "uuid-of-tools-sink",
    "tutorials": "uuid-of-tutorials-sink"
  },
  "customInstructions": "Optional: any additional instructions for the analysis"
}
```

### Configuration Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | `boolean` | Yes | Toggle the agent on/off |
| `keywords` | `string[]` | Yes | Twitter search keywords to scrape |
| `maxItems` | `number` | No | Max tweets to scrape per run (default 200) |
| `companyName` | `string` | Yes | Your company/product name |
| `companyWebsite` | `string` | Yes | Your company website URL |
| `companyDescription` | `string` | Yes | Description of what your product does |
| `founderName` | `string` | Yes | Name of the person who will be commenting |
| `founderContext` | `string` | Yes | Context about the founder's social media strategy |
| `sinks.opportunities` | `string` | No* | Sink ID for comment opportunities |
| `sinks.trends` | `string` | No* | Sink ID for trends |
| `sinks.tools` | `string` | No* | Sink ID for new tools/companies |
| `sinks.tutorials` | `string` | No* | Sink ID for tutorial ideas |
| `customInstructions` | `string` | No | Additional instructions appended to the analysis prompt |

*At least one sink ID is required.

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
