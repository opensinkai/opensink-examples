import { FastifyInstance } from 'fastify';
import { ApifyClient } from 'apify-client';
import OpenAI from 'openai';
import OpenSink, { AgentSessionStatus, AgentSessionActivityType, AgentSessionActivitySource } from 'opensink';

// ---------------------------------------------------------------------------
// SDK clients
// ---------------------------------------------------------------------------

const opensinkAPIKey = process.env.OPEN_SINK_API_KEY || '';

if (!opensinkAPIKey) {
  throw new Error('OPEN_SINK_API_KEY is not set');
}

if (!process.env.APIFY_API_TOKEN) {
  throw new Error('APIFY_API_TOKEN is not set');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openSink = new OpenSink({
  apiKey: opensinkAPIKey,
  url: process.env.OPEN_SINK_URL,
});
const apify = new ApifyClient({
  token: process.env.APIFY_API_TOKEN,
});

// ---------------------------------------------------------------------------
// OpenSink entity IDs – replace with your own after creating them in the UI
// ---------------------------------------------------------------------------

const AGENT_ID = '019c5475-f425-757d-aca6-89d24a171310';
const OPPORTUNITIES_SINK_ID = '019c547c-909c-703f-ba89-ed43cb23dca1';
const TRENDS_SINK_ID = '019c547c-9298-73ef-80d7-6f8897898e54';
const TOOLS_SINK_ID = '019c547c-9497-71bc-accb-2bb463a74e5b';
const TUTORIALS_SINK_ID = '019c547c-96bf-758a-8152-619119f78694';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfigValue {
  enabled: boolean;
  keywords: string[];
  maxItems: number;
}

/** Shape returned by the apidojo/tweet-scraper Apify actor */
interface ApifyTweet {
  type: string;
  id: string;
  url: string;
  text: string;
  retweetCount: number;
  replyCount: number;
  likeCount: number;
  quoteCount: number;
  bookmarkCount: number;
  createdAt: string;
  lang: string;
  isRetweet: boolean;
  isReply: boolean;
  author: {
    type: string;
    userName: string;
    url: string;
    id: string;
    name: string;
    isVerified: boolean;
    isBlueVerified: boolean;
    followers: number;
    following: number;
    profilePicture: string;
  };
}

/** Normalized tweet for the analysis prompt */
interface NormalizedTweet {
  id: string;
  text: string;
  author: string;
  author_followers: number;
  likes: number;
  retweets: number;
  replies: number;
  url: string;
  created_at: string;
}

interface CommentOpportunity {
  tweet_text: string;
  tweet_url: string;
  author: string;
  author_followers: number;
  why_comment: string;
  suggested_angle: string;
  engagement_score: number;
}

interface TrendEvidence {
  text: string;
  url: string;
  author: string;
}

interface Trend {
  theme: string;
  evidence_tweets: TrendEvidence[];
  sentiment: 'hype' | 'frustration' | 'curiosity' | 'fatigue';
  opensink_relevance: string;
}

interface NewTool {
  name: string;
  description: string;
  url: string;
  relationship: 'competitor' | 'potential_partner' | 'irrelevant';
  opensink_connection: string;
}

interface TutorialIdea {
  title: string;
  why_timely: string;
  outline: string[];
  effort: 'quick' | 'medium' | 'deep';
}

interface AnalysisResult {
  comment_opportunities: CommentOpportunity[];
  trends: Trend[];
  new_tools: NewTool[];
  tutorial_ideas: TutorialIdea[];
  run_summary: string;
}

// ---------------------------------------------------------------------------
// Apify: scrape tweets
// ---------------------------------------------------------------------------

async function scrapeTweets(keywords: string[], maxItems: number): Promise<ApifyTweet[]> {
  // Build search terms using Twitter advanced search syntax.
  // Each keyword becomes its own search term so the actor fetches across all of them.
  const searchTerms = keywords.map((kw) => `${kw} lang:en`);

  console.log(`Starting Apify tweet scraper with ${searchTerms.length} search terms, maxItems=${maxItems}`);

  const run = await apify.actor('apidojo/twitter-scraper-lite').call({
    searchTerms,
    maxItems,
    sort: 'Latest',
    tweetLanguage: 'en',
  });

  const { items } = await apify.dataset(run.defaultDatasetId).listItems();
  return items as unknown as ApifyTweet[];
}

/** Convert Apify output to our normalized format, filtering out noise */
function normalizeTweets(raw: ApifyTweet[]): NormalizedTweet[] {
  return raw
    .filter((t) => {
      // Skip retweets – they're duplicates
      if (t.isRetweet) return false;
      // Skip tweets with no meaningful text
      if (!t.text || t.text.trim().length < 20) return false;
      // Only keep tweets typed as "tweet"
      if (t.type !== 'tweet') return false;
      return true;
    })
    .map((t) => ({
      id: t.id,
      text: t.text,
      author: t.author?.userName || 'unknown',
      author_followers: t.author?.followers || 0,
      likes: t.likeCount || 0,
      retweets: t.retweetCount || 0,
      replies: t.replyCount || 0,
      url: t.url,
      created_at: t.createdAt,
    }));
}

// ---------------------------------------------------------------------------
// JSON Schema for structured GPT output
// ---------------------------------------------------------------------------

const analysisSchema = {
  type: 'object',
  properties: {
    comment_opportunities: {
      type: 'array',
      description: 'Top 10 tweets where Dan could leave a valuable comment that naturally relates to OpenSink.',
      items: {
        type: 'object',
        properties: {
          tweet_text: { type: 'string', description: 'Truncated tweet text (max 200 chars)' },
          tweet_url: { type: 'string', description: 'URL to the tweet' },
          author: { type: 'string', description: 'Twitter handle of the author' },
          author_followers: { type: 'number', description: 'Follower count of the author' },
          why_comment: { type: 'string', description: 'Why this is a good opportunity to comment' },
          suggested_angle: { type: 'string', description: 'Suggested angle for the comment — NOT the comment itself' },
          engagement_score: { type: 'number', description: 'Combined engagement (likes + retweets + replies)' },
        },
        required: ['tweet_text', 'tweet_url', 'author', 'author_followers', 'why_comment', 'suggested_angle', 'engagement_score'],
        additionalProperties: false,
      },
    },
    trends: {
      type: 'array',
      description: 'Top 5 emerging themes from the scraped data.',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'Short theme name' },
          evidence_tweets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Tweet snippet as evidence (max 100 chars)' },
                url: { type: 'string', description: 'URL to the tweet' },
                author: { type: 'string', description: 'Twitter handle of the author' },
              },
              required: ['text', 'url', 'author'],
              additionalProperties: false,
            },
            description: 'Example tweets as evidence with their URLs',
          },
          sentiment: { type: 'string', enum: ['hype', 'frustration', 'curiosity', 'fatigue'], description: 'Overall sentiment' },
          opensink_relevance: { type: 'string', description: 'How OpenSink relates — be honest when it does not' },
        },
        required: ['theme', 'evidence_tweets', 'sentiment', 'opensink_relevance'],
        additionalProperties: false,
      },
    },
    new_tools: {
      type: 'array',
      description: 'New products, launches, or repos mentioned in the data.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product or tool name' },
          description: { type: 'string', description: 'What it does in one line' },
          url: { type: 'string', description: 'Link to the tool/product' },
          relationship: { type: 'string', enum: ['competitor', 'potential_partner', 'irrelevant'], description: 'Relationship to OpenSink' },
          opensink_connection: { type: 'string', description: 'One line on how it relates to OpenSink\'s space' },
        },
        required: ['name', 'description', 'url', 'relationship', 'opensink_connection'],
        additionalProperties: false,
      },
    },
    tutorial_ideas: {
      type: 'array',
      description: 'Top 3 "Build X with OpenSink" tutorial ideas based on trends.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Tutorial title' },
          why_timely: { type: 'string', description: 'What trend this rides' },
          outline: {
            type: 'array',
            items: { type: 'string' },
            description: '3-5 bullet point outline',
          },
          effort: { type: 'string', enum: ['quick', 'medium', 'deep'], description: 'Estimated effort: quick (1hr), medium (half day), deep (full day)' },
        },
        required: ['title', 'why_timely', 'outline', 'effort'],
        additionalProperties: false,
      },
    },
    run_summary: {
      type: 'string',
      description: 'One paragraph summary of this run. If nothing interesting was found, say so honestly.',
    },
  },
  required: ['comment_opportunities', 'trends', 'new_tools', 'tutorial_ideas', 'run_summary'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// System prompt for Scout
// ---------------------------------------------------------------------------

const SCOUT_SYSTEM_PROMPT = `You are Scout, a marketing intelligence agent for OpenSink (opensink.com).

OpenSink is the memory and control layer for AI agents in production. It provides Sessions, Sinks, and Activities — primitives that let developers track what their agents do, store persistent memory, and maintain human oversight. It's framework-agnostic, API-first, and early stage.

Context about the founder:
- Dan is a solo founder and developer at early stage.
- Low social media following. Strategy: comment on high-traffic posts rather than posting into the void.

Your job: analyze scraped Twitter data and produce marketing intelligence.

## Rules
- Be blunt and honest. Don't force OpenSink relevance where there is none.
- Skip low-quality tweets, spam, and engagement bait.
- Don't suggest commenting on the same accounts repeatedly — diversify.
- Prioritize recency and engagement.
- If the data has nothing interesting, say so. Don't pad the output.

## Output sections

### 1. Comment Opportunities (top 10)
Find tweets where Dan could leave a valuable comment that naturally relates to OpenSink. Prioritize:
- High engagement posts (lots of eyes)
- Questions people are asking (Dan can answer)
- Developers sharing agent builds (Dan can suggest OpenSink)
- Hot takes or debates Dan can add a smart perspective to

For each: tweet text (truncated), link, author + follower count, why comment here, suggested angle (NOT the comment itself — Dan writes in his own voice), engagement score.

### 2. Trends (top 5)
What themes keep showing up? What's the community excited/frustrated/curious about?
- Theme name, evidence tweets, sentiment (hype/frustration/curiosity/fatigue), how OpenSink relates (be honest when it doesn't).

### 3. New Tools & Companies
Any new products, launches, or repos mentioned? For each: name, what it does, link, relationship to OpenSink (competitor/potential_partner/irrelevant), one line on how it relates to OpenSink's space.

### 4. Tutorial Ideas (top 3)
Based on trends, suggest "Build X with OpenSink" tutorials. Title, why timely, brief outline (3-5 bullets), effort estimate (quick/medium/deep).

### 5. Run Summary
One paragraph. Be concise. If the run is boring, say so.`;

// ---------------------------------------------------------------------------
// Core analysis function
// ---------------------------------------------------------------------------

async function analyzeTwitterData(tweets: NormalizedTweet[]): Promise<AnalysisResult> {
  // Limit tweets to avoid payload size issues - prioritize by engagement
  const sortedTweets = [...tweets]
    .sort((a, b) => (b.likes + b.retweets + b.replies) - (a.likes + a.retweets + a.replies))
    .slice(0, 100);

  const tweetList = sortedTweets
    .map((t, i) => {
      const engagement = t.likes + t.retweets + t.replies;
      const truncatedText = t.text.length > 500 ? t.text.slice(0, 500) + '...' : t.text;
      return `${i + 1}. @${t.author} (${t.author_followers.toLocaleString()} followers) [engagement: ${engagement}]
URL: ${t.url}
Posted: ${t.created_at}
"${truncatedText}"`;
    })
    .join('\n\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SCOUT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Here are ${tweets.length} scraped tweets from the last few hours. Analyze them and produce your intelligence report.\n\n${tweetList}`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'scout_analysis',
        strict: true,
        schema: analysisSchema,
      },
    },
  });

  const result = JSON.parse(response.choices[0].message.content || '{}');
  return result as AnalysisResult;
}

// ---------------------------------------------------------------------------
// Format Telegram message
// ---------------------------------------------------------------------------

function formatTelegramMessage(analysis: AnalysisResult): string {
  const lines: string[] = [];

  lines.push('--- SCOUT MARKETING INTEL ---\n');

  // Comment Opportunities
  if (analysis.comment_opportunities.length > 0) {
    lines.push('TARGET COMMENT OPPORTUNITIES\n');
    for (const opp of analysis.comment_opportunities) {
      lines.push(`  @${opp.author} (${opp.author_followers.toLocaleString()} followers) | engagement: ${opp.engagement_score}`);
      lines.push(`  "${opp.tweet_text}"`);
      lines.push(`  ${opp.tweet_url}`);
      lines.push(`  Why: ${opp.why_comment}`);
      lines.push(`  Angle: ${opp.suggested_angle}`);
      lines.push('');
    }
  }

  // Trends
  if (analysis.trends.length > 0) {
    lines.push('TRENDS\n');
    for (const trend of analysis.trends) {
      lines.push(`  ${trend.theme} [${trend.sentiment}]`);
      lines.push(`  OpenSink relevance: ${trend.opensink_relevance}`);
      const evidenceText = trend.evidence_tweets.slice(0, 2).map((e) => `@${e.author}: "${e.text}"`).join(' | ');
      lines.push(`  Evidence: ${evidenceText}`);
      lines.push('');
    }
  }

  // New Tools
  if (analysis.new_tools.length > 0) {
    lines.push('NEW TOOLS & COMPANIES\n');
    for (const tool of analysis.new_tools) {
      lines.push(`  ${tool.name} — ${tool.description}`);
      lines.push(`  ${tool.url}`);
      lines.push(`  Relationship: ${tool.relationship} | ${tool.opensink_connection}`);
      lines.push('');
    }
  }

  // Tutorial Ideas
  if (analysis.tutorial_ideas.length > 0) {
    lines.push('TUTORIAL IDEAS\n');
    for (const idea of analysis.tutorial_ideas) {
      lines.push(`  "${idea.title}" [${idea.effort}]`);
      lines.push(`  Why now: ${idea.why_timely}`);
      for (const bullet of idea.outline) {
        lines.push(`    - ${bullet}`);
      }
      lines.push('');
    }
  }

  // Summary
  lines.push('SUMMARY\n');
  lines.push(`  ${analysis.run_summary}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Activity logging helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function routes(app: FastifyInstance) {
  app.get('/', async () => ({ status: 'ok' }));

  /**
   * POST /agent/run
   *
   * Scrapes Twitter via Apify for the configured keywords, runs Scout
   * analysis with GPT-4o-mini, stores results in OpenSink sinks, and
   * returns a Telegram-formatted summary.
   *
   * Keywords and maxItems are read from the OpenSink agent configuration.
   */
  app.post('/agent/run', async () => {
    // Fetch agent configuration
    const configRes = await openSink.agentConfigurations.getActiveForAgent<AgentConfigValue>(AGENT_ID);
    const config = configRes.data.value;

    console.info('got config', config);

    if (!config.enabled) {
      console.log('Agent is disabled, skipping run');
      return { success: false, reason: 'Agent is disabled' };
    }

    const keywords = config.keywords;
    const maxItems = config.maxItems || 200;

    if (!keywords || keywords.length === 0) {
      return { success: false, reason: 'No keywords configured. Set keywords in the OpenSink agent configuration.' };
    }

    // Start a new session
    const session = await openSink.agentSessions.create({
      agent_id: AGENT_ID,
      status: AgentSessionStatus.RUNNING,
      metadata: { startedAt: new Date().toISOString() },
    });

    try {
      // -----------------------------------------------------------------------
      // Step 1: Scrape tweets from Twitter via Apify
      // -----------------------------------------------------------------------

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        `Scraping Twitter via Apify for ${keywords.length} keywords (max ${maxItems} tweets)...`,
      );

      await openSink.agentSessions.update(session.data.id, {
        state: { phase: 'scraping', keywords, maxItems },
      });

      const rawTweets = await scrapeTweets(keywords, maxItems);
      const tweets = normalizeTweets(rawTweets);

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        `Scraped ${rawTweets.length} raw tweets, ${tweets.length} after filtering retweets and noise.`,
      );

      if (tweets.length === 0) {
        await openSink.agentSessions.update(session.data.id, {
          status: AgentSessionStatus.COMPLETED,
          state: { phase: 'completed', reason: 'no_tweets_found' },
        });
        return { success: true, reason: 'No relevant tweets found for the given keywords.' };
      }

      // -----------------------------------------------------------------------
      // Step 2: Analyze with GPT-4o-mini
      // -----------------------------------------------------------------------

      await openSink.agentSessions.update(session.data.id, {
        state: { phase: 'analyzing', tweetsToAnalyze: tweets.length },
      });

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        `Analyzing ${tweets.length} tweets with GPT-4o-mini...`,
      );

      const analysis = await analyzeTwitterData(tweets);

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        `Analysis complete. Found ${analysis.comment_opportunities.length} comment opportunities, ${analysis.trends.length} trends, ${analysis.new_tools.length} new tools, ${analysis.tutorial_ideas.length} tutorial ideas.`,
      );

      // -----------------------------------------------------------------------
      // Step 3: Store results in OpenSink sinks
      // -----------------------------------------------------------------------

      await openSink.agentSessions.update(session.data.id, {
        state: {
          phase: 'storing_results',
          tweetsAnalyzed: tweets.length,
          commentOpportunities: analysis.comment_opportunities.length,
          trends: analysis.trends.length,
          newTools: analysis.new_tools.length,
          tutorialIdeas: analysis.tutorial_ideas.length,
        },
      });

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.STATE_UPDATED,
        AgentSessionActivitySource.AGENT,
        'Updated session state with analysis counts',
      );

      // 1. Comment Opportunities
      if (analysis.comment_opportunities.length > 0) {
        const oppItems = analysis.comment_opportunities.map((opp) => ({
          sink_id: OPPORTUNITIES_SINK_ID,
          title: `@${opp.author}: ${opp.tweet_text.slice(0, 80)}...`,
          body: `Why: ${opp.why_comment}\nAngle: ${opp.suggested_angle}`,
          url: opp.tweet_url,
          fields: {
            author: opp.author,
            author_followers: opp.author_followers,
            engagement_score: opp.engagement_score,
            suggested_angle: opp.suggested_angle,
          },
          resources: [
            { type: 'link' as const, label: 'View Tweet', url: opp.tweet_url },
            { type: 'link' as const, label: `@${opp.author}'s Profile`, url: `https://twitter.com/${opp.author}` },
          ],
        }));

        const oppResult = await openSink.sinkItems.createMany(oppItems);

        await logActivity(
          session.data.id,
          AGENT_ID,
          AgentSessionActivityType.SINK_ITEM_CREATED,
          AgentSessionActivitySource.AGENT,
          `Created ${oppResult.data.created.length} comment opportunity items`,
        );
      }

      // 2. Trends
      if (analysis.trends.length > 0) {
        const trendItems = analysis.trends.map((trend) => ({
          sink_id: TRENDS_SINK_ID,
          title: `${trend.theme} [${trend.sentiment}]`,
          body: `Evidence: ${trend.evidence_tweets.map((e) => `@${e.author}: "${e.text}"`).join(' | ')}\nOpenSink relevance: ${trend.opensink_relevance}`,
          fields: {
            sentiment: trend.sentiment,
            opensink_relevance: trend.opensink_relevance,
          },
          resources: trend.evidence_tweets.map((e) => ({
            type: 'link' as const,
            label: `@${e.author}'s Tweet`,
            url: e.url,
          })),
        }));

        const trendResult = await openSink.sinkItems.createMany(trendItems);

        await logActivity(
          session.data.id,
          AGENT_ID,
          AgentSessionActivityType.SINK_ITEM_CREATED,
          AgentSessionActivitySource.AGENT,
          `Created ${trendResult.data.created.length} trend items`,
        );
      }

      // 3. New Tools & Companies
      if (analysis.new_tools.length > 0) {
        const toolItems = analysis.new_tools.map((tool) => ({
          sink_id: TOOLS_SINK_ID,
          title: tool.name,
          body: `${tool.description}\n${tool.opensink_connection}`,
          url: tool.url,
          fields: {
            relationship: tool.relationship,
            opensink_connection: tool.opensink_connection,
          },
        }));

        const toolResult = await openSink.sinkItems.createMany(toolItems);

        await logActivity(
          session.data.id,
          AGENT_ID,
          AgentSessionActivityType.SINK_ITEM_CREATED,
          AgentSessionActivitySource.AGENT,
          `Created ${toolResult.data.created.length} new tool items`,
        );
      }

      // 4. Tutorial Ideas
      if (analysis.tutorial_ideas.length > 0) {
        const tutorialItems = analysis.tutorial_ideas.map((idea) => ({
          sink_id: TUTORIALS_SINK_ID,
          title: idea.title,
          body: `Why timely: ${idea.why_timely}\nOutline:\n${idea.outline.map((b) => `- ${b}`).join('\n')}`,
          fields: {
            effort: idea.effort,
            why_timely: idea.why_timely,
          },
        }));

        const tutorialResult = await openSink.sinkItems.createMany(tutorialItems);

        await logActivity(
          session.data.id,
          AGENT_ID,
          AgentSessionActivityType.SINK_ITEM_CREATED,
          AgentSessionActivitySource.AGENT,
          `Created ${tutorialResult.data.created.length} tutorial idea items`,
        );
      }

      // -----------------------------------------------------------------------
      // Step 4: Format report and complete session
      // -----------------------------------------------------------------------

      const telegramMessage = formatTelegramMessage(analysis);

      await logActivity(
        session.data.id,
        AGENT_ID,
        AgentSessionActivityType.MESSAGE,
        AgentSessionActivitySource.AGENT,
        'Generated Telegram-formatted report',
      );

      await openSink.agentSessions.update(session.data.id, {
        status: AgentSessionStatus.COMPLETED,
        state: {
          phase: 'completed',
          tweetsScraped: rawTweets.length,
          tweetsAnalyzed: tweets.length,
          commentOpportunities: analysis.comment_opportunities.length,
          trends: analysis.trends.length,
          newTools: analysis.new_tools.length,
          tutorialIdeas: analysis.tutorial_ideas.length,
        },
      });

      return {
        success: true,
        stats: {
          tweetsScraped: rawTweets.length,
          tweetsAnalyzed: tweets.length,
          commentOpportunities: analysis.comment_opportunities.length,
          trends: analysis.trends.length,
          newTools: analysis.new_tools.length,
          tutorialIdeas: analysis.tutorial_ideas.length,
        },
        analysis,
        telegram_message: telegramMessage,
      };
    } catch (error) {
      console.error('Error during agent run:', error);

      await openSink.agentSessions.update(session.data.id, {
        status: AgentSessionStatus.FAILED,
        error_message: error instanceof Error ? error.message : String(error),
      });

      return { success: false, reason: (error as Error).message };
    }
  });
}
