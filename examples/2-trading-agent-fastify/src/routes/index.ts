import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import OpenSink, { AgentSessionStatus } from 'opensink';

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

const tradesSchema = {
  type: 'object',
  properties: {
    trades: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Stock/crypto symbol (e.g., AAPL, BTC)' },
          action: { type: 'string', enum: ['buy', 'sell'], description: 'Trade action' },
          quantity: { type: 'number', description: 'Number of shares/units' },
          reason: { type: 'string', description: 'Brief explanation for the trade based on the news' },
        },
        required: ['symbol', 'action', 'quantity', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['trades'],
  additionalProperties: false,
} as const;

type Article = { title: string; url: string; summary: string; category: string };
type Trade = { symbol: string; action: 'buy' | 'sell'; quantity: number; reason: string };

async function pickTopArticles(articles: { title: string; description: string; url: string }[], count: number): Promise<Article[]> {
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

async function proposeTrades(articles: Article[]): Promise<Trade[]> {
  const articlesSummary = articles
    .map((a, i) => `${i + 1}. [${a.category.toUpperCase()}] ${a.title}\n   ${a.summary}`)
    .join('\n\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a trading analyst. Based on the provided financial news, propose 3-5 trades (buy or sell) that could be profitable. Consider market sentiment, sector trends, and potential impacts from the news. Be specific about symbols, actions, and quantities.`,
      },
      { role: 'user', content: `Here are today's top financial news:\n\n${articlesSummary}\n\nPropose trades based on this news.` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'trades_response',
        strict: true,
        schema: tradesSchema,
      },
    },
  });

  const result = JSON.parse(response.choices[0].message.content || '{"trades":[]}');
  return result.trades;
}

function buildTradeApprovalSchema(trades: Trade[]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  trades.forEach((trade, i) => {
    const key = `trade_${i}`;
    required.push(key);

    properties[key] = {
      type: 'object',
      title: `${trade.action.toUpperCase()} ${trade.quantity} ${trade.symbol}`,
      description: trade.reason,
      properties: {
        symbol: { type: 'string', const: trade.symbol, default: trade.symbol, readOnly: true },
        action: { type: 'string', const: trade.action, default: trade.action, readOnly: true },
        quantity: { type: 'number', const: trade.quantity, default: trade.quantity, readOnly: true },
        approved: { type: 'boolean', title: 'Approve this trade', default: false },
      },
      required: ['approved'],
    };
  });

  properties['notes'] = {
    type: 'string',
    title: 'Notes',
    description: 'Optional notes or instructions',
  };

  return {
    type: 'object',
    properties,
    required,
  };
}

const NEWS_SINK_ID = '019c05ce-5daf-72c9-bc1e-cb778bc40816';
const TRADES_SINK_ID = '019c1b5e-3541-76ed-bd07-73a17acf7f14';
const AGENT_ID = '019c1b31-257a-7356-963c-7f68da740677';

interface AgentConfigValue {
  enabled: boolean;
  newItemsCount: number;
}

async function startNewWorkflow() {
  // Fetch agent configuration
  const configRes = await openSink.agentConfigurations.getActiveForAgent<AgentConfigValue>(AGENT_ID);
  const config = configRes.data.value;

  console.info('Got config:', config);

  if (!config.enabled) {
    console.log('Agent is disabled, skipping run');
    return { success: false, reason: 'Agent is disabled' };
  }

  // Start a new session
  const sessionRes = await openSink.agentSessions.create({
    agent_id: AGENT_ID,
    status: AgentSessionStatus.RUNNING,
    state: { phase: 'analyzing_news' },
    metadata: { startedAt: new Date().toISOString() },
  });
  const session = sessionRes.data;

  try {
    const itemsToFetch = config.newItemsCount || 10;
    console.log(`Fetching top ${itemsToFetch} financial news...`);

    const articles = await fetchFinancialNews();
    console.log(`Found ${articles.length} articles`);

    const topArticles = await pickTopArticles(articles, itemsToFetch);
    console.log(`Selected ${topArticles.length} top articles`);

    // Update session state
    await openSink.agentSessions.update(session.id, {
      state: { phase: 'proposing_trades', articles: topArticles },
    });

    // Propose trades based on the news
    console.log('Proposing trades based on news...');
    const proposedTrades = await proposeTrades(topArticles);
    console.log(`Proposed ${proposedTrades.length} trades:`);
    proposedTrades.forEach((trade, i) => {
      console.log(`  ${i + 1}. ${trade.action.toUpperCase()} ${trade.quantity} ${trade.symbol} - ${trade.reason}`);
    });

    // Store proposed trades in session state
    await openSink.agentSessions.update(session.id, {
      state: { phase: 'awaiting_approval', articles: topArticles, proposedTrades },
    });

    // Create input request for trade approval
    const inputRequest = await openSink.agentSessionInputRequests.create({
      session_id: session.id,
      agent_id: AGENT_ID,
      key: 'trade_approval',
      title: `Approve ${proposedTrades.length} proposed trades`,
      message: `Please review each proposed trade and approve or reject individually.`,
      schema: buildTradeApprovalSchema(proposedTrades),
    });

    console.log(`Created input request ${inputRequest.data.id} - waiting for approval`);

    // Write news items to opensink
    const sinkItems = topArticles.map(article => ({
      sink_id: NEWS_SINK_ID,
      title: article.title,
      body: article.summary,
      url: article.url,
      fields: { category: article.category },
    }));

    await openSink.sinkItems.createMany(sinkItems);
    console.log(`Created ${sinkItems.length} news items in OpenSink`);

    return {
      success: true,
      sessionId: session.id,
      inputRequestId: inputRequest.data.id,
      articles: topArticles,
      proposedTrades,
      status: 'awaiting_approval',
    };
  } catch (error) {
    console.error('Error during agent run:', error);

    await openSink.agentSessions.update(session.id, {
      status: AgentSessionStatus.FAILED,
      error_message: error instanceof Error ? error.message : String(error),
    });

    return { success: false, reason: (error as Error).message };
  }
}

async function handleTradeExecution(sessionId: string, requestId: string) {
  console.log(`Continuing workflow - Session: ${sessionId}, Request: ${requestId}`);

  try {
    // Get the session to retrieve the proposed trades
    const sessionRes = await openSink.agentSessions.get(sessionId);
    const session = sessionRes.data;
    const state = session.state as { proposedTrades?: Trade[]; articles?: Article[] };

    // Get the input request to check the response
    const requestRes = await openSink.agentSessionInputRequests.get(requestId);
    const inputRequest = requestRes.data;
    const response = inputRequest.response as Record<string, { symbol: string; action: string; quantity: number; approved: boolean }> & { notes?: string } | null;

    if (!response) {
      return { success: false, reason: 'No response found' };
    }

    // Filter approved trades
    const allTrades = state.proposedTrades || [];
    const approvedTrades: Trade[] = [];
    const rejectedTrades: Trade[] = [];

    allTrades.forEach((trade, i) => {
      const tradeResponse = response[`trade_${i}`];
      if (tradeResponse?.approved) {
        approvedTrades.push(trade);
      } else {
        rejectedTrades.push(trade);
      }
    });

    if (approvedTrades.length === 0) {
      console.log('No trades were approved');

      await openSink.agentSessions.update(sessionId, {
        status: AgentSessionStatus.COMPLETED,
        state: { ...state, phase: 'rejected', rejectedTrades, notes: response?.notes },
      });

      return { success: true, status: 'rejected', rejectedCount: rejectedTrades.length, notes: response?.notes };
    }

    console.log(`${approvedTrades.length} trades approved, ${rejectedTrades.length} rejected`);

    await openSink.agentSessions.update(sessionId, {
      state: { ...state, phase: 'executing_trades' },
    });

    // Simulate trade execution
    const executedTrades = approvedTrades.map(trade => ({
      ...trade,
      executedAt: new Date().toISOString(),
      status: 'executed',
    }));

    console.log('Executed trades:');
    executedTrades.forEach((trade, i) => {
      console.log(`  ${i + 1}. ${trade.action.toUpperCase()} ${trade.quantity} ${trade.symbol} - EXECUTED`);
    });

    // Record executed trades in the sink
    const tradeItems = executedTrades.map(trade => ({
      sink_id: TRADES_SINK_ID,
      title: `${trade.action.toUpperCase()} ${trade.quantity} ${trade.symbol}`,
      body: trade.reason,
      fields: {
        symbol: trade.symbol,
        action: trade.action,
        quantity: trade.quantity,
        executedAt: trade.executedAt,
        ...(response?.notes && { approvalNotes: response.notes }),
      },
    }));

    await openSink.sinkItems.createMany(tradeItems);

    // Complete the session
    await openSink.agentSessions.update(sessionId, {
      status: AgentSessionStatus.COMPLETED,
      state: { ...state, phase: 'completed', executedTrades, rejectedTrades, notes: response?.notes },
    });

    return {
      success: true,
      status: 'executed',
      executedCount: executedTrades.length,
      rejectedCount: rejectedTrades.length,
      trades: executedTrades,
    };
  } catch (error) {
    console.error('Error executing trades:', error);

    await openSink.agentSessions.update(sessionId, {
      status: AgentSessionStatus.FAILED,
      error_message: error instanceof Error ? error.message : String(error),
    });

    return { success: false, reason: (error as Error).message };
  }
}

export default async function routes(app: FastifyInstance) {
  app.get('/', async () => ({ status: 'ok' }));

  app.post('/agent/run', async (req) => {
    const sessionId = req.headers['x-opensink-session-id'] as string | undefined;
    const requestId = req.headers['x-opensink-request-id'] as string | undefined;

    console.info('running agent', sessionId, requestId);

    // If we have session and request IDs, this is a continuation after approval
    if (sessionId && requestId) {
      return handleTradeExecution(sessionId, requestId);
    }

    // Otherwise, start a new workflow
    return startNewWorkflow();
  });
}
