import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import OpenSink, { AgentSessionStatus, AgentSessionActivityType, AgentSessionActivitySource } from 'opensink';

const opensinkAPIKey = process.env.OPEN_SINK_API_KEY || '';

if (!opensinkAPIKey) {
  throw new Error('OPEN_SINK_API_KEY is not set');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openSink = new OpenSink({
  apiKey: opensinkAPIKey,
  url: process.env.OPEN_SINK_URL,
});

async function fetchFinancialNews() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `https://newsapi.org/v2/everything?q=finance+OR+stock+OR+market&from=${yesterday}&sortBy=publishedAt&pageSize=50&apiKey=${process.env.NEWSAPI_KEY}`;

  const res = await fetch(url);
  const data = await res.json();
  return data.articles || [];
}

const newsSchema = {
  type: 'object',
  properties: {
    articles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Original article title' },
          url: { type: 'string', description: 'Original article URL' },
          summary: { type: 'string', description: 'Brief 1-2 sentence summary of the article' },
          category: { type: 'string', enum: ['stocks', 'crypto', 'economy', 'earnings', 'markets', 'policy', 'commodities', 'other'] },
        },
        required: ['title', 'url', 'summary', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['articles'],
  additionalProperties: false,
} as const;

async function pickTopArticles(articles: { title: string; description: string; url: string }[], count: number) {
  const articleList = articles
    .map((a, i) => `${i + 1}. [URL: ${a.url}]\nTitle: ${a.title}\nDescription: ${a.description || 'N/A'}`)
    .join('\n\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a financial news analyst. From the provided news articles, pick the ${count} most important ones. For each, provide the original title, URL, a brief summary, and a category.`,
      },
      { role: 'user', content: articleList },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'news_response',
        strict: true,
        schema: newsSchema,
      },
    },
  });

  const result = JSON.parse(response.choices[0].message.content || '{"articles":[]}');
  return result.articles;
}

const NEWS_SINK_ID = '019c05ce-5daf-72c9-bc1e-cb778bc40816';
const AGENT_ID = '019c164c-ae84-759f-a6dc-6e28b107096b';

interface AgentConfigValue {
  enabled: boolean;
  newItemsCount: number;
}

// Helper to log activity
async function logActivity(
  sessionId: string,
  agentId: string,
  type: AgentSessionActivityType,
  source: AgentSessionActivitySource,
  message?: string,
  relatedEntityId?: string,
  payload?: Record<string, unknown>,
) {
  try {
    await openSink.agentSessionActivities.create({
      session_id: sessionId,
      agent_id: agentId,
      type,
      source,
      message,
      related_entity_id: relatedEntityId,
      payload,
    });
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

export default async function routes(app: FastifyInstance) {
  app.get('/', async () => ({ status: 'ok' }));

  app.post('/agent/run', async () => {
    // Fetch agent configuration
    const configRes = await openSink.agentConfigurations.getActiveForAgent<AgentConfigValue>(AGENT_ID);
    const config = configRes.data.value;

    console.info('got config', config);

    if (!config.enabled) {
      console.log('Agent is disabled, skipping run');
      return { success: false, reason: 'Agent is disabled' };
    }

    // Start a new session
    const session = await openSink.agentSessions.create({
      agent_id: AGENT_ID,
      status: AgentSessionStatus.RUNNING,
    });

    try {
      const itemsToFetch = config.newItemsCount || 10;

      // Log fetching news
      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        `Fetching financial news from NewsAPI...`,
      );

      const articles = await fetchFinancialNews();

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        `Found ${articles.length} articles. Analyzing with AI to select top ${itemsToFetch}...`,
      );

      const topArticles = await pickTopArticles(articles, itemsToFetch);

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        `Selected ${topArticles.length} most important articles`,
      );

      // Log state update
      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.STATE_UPDATED,
        AgentSessionActivitySource.AGENT,
        'Updated session state with selected articles',
      );

      await openSink.agentSessions.update(session.data.id, {
        state: { articles: topArticles },
      });

      // Write items to opensink in bulk
      const sinkItems = topArticles.map((article: { title: string; url: string; summary: string; category: string }) => ({
        sink_id: NEWS_SINK_ID,
        title: article.title,
        body: article.summary,
        url: article.url,
        fields: {
          category: article.category,
        },
      }));

      const result = await openSink.sinkItems.createMany(sinkItems);

      // Log items created
      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.SINK_ITEM_CREATED,
        AgentSessionActivitySource.AGENT,
        `Created ${result.data.created.length} news items in sink`,
      );

      // End the session (backend auto-creates session_ended activity)
      await openSink.agentSessions.update(session.data.id, {
        status: AgentSessionStatus.COMPLETED,
      });

      return { success: true, count: topArticles.length, articles: topArticles, opensink: result.data };
    } catch (error) {
      console.error('Error during agent run:', error);

      // Update session status to failed (backend auto-creates session_ended activity)
      await openSink.agentSessions.update(session.data.id, {
        status: AgentSessionStatus.FAILED,
        error_message: error instanceof Error ? error.message : String(error),
      });

      return { success: false, reason: (error as Error).message };
    }
  });
}
