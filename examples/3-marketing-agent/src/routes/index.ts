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
// OpenSink Agent ID – replace with your own after creating it in the UI
// ---------------------------------------------------------------------------

const AGENT_ID = process.env.AGENT_ID || '019c5475-f425-757d-aca6-89d24a171310';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfigValue {
  enabled: boolean;
  keywords: string[];
  maxItems: number;
  // Company/Product configuration
  companyName: string;
  companyWebsite: string;
  companyDescription: string;
  // User/Founder context
  founderName: string;
  founderContext: string;
  // Sink IDs for storing results
  sinks: {
    opportunities: string;
    trends: string;
    tools: string;
    tutorials: string;
  };
  // Optional custom instructions (appended to default prompt)
  customInstructions?: string;
  // Tweet filtering options
  filters?: {
    minLikes?: number;
    minRetweets?: number;
    minReplies?: number;
    minAuthorFollowers?: number;
    onlyVerified?: boolean;
  };
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
  draft_comment: string;
  engagement_score: number;
}

interface TrendEvidence {
  text: string;
  url: string;
  author: string;
}

interface Trend {
  theme: string;
  tweet_count: number;
  evidence_tweets: TrendEvidence[];
  why_trending: string;
  sentiment: 'hype' | 'frustration' | 'curiosity' | 'fatigue' | 'debate';
  company_relevance: string;
}

interface SourceTweet {
  url: string;
  author: string;
}

interface NewTool {
  name: string;
  description: string;
  url: string;
  relationship: 'competitor' | 'potential_partner' | 'complementary' | 'irrelevant';
  company_relevance: string;
  source_tweets: SourceTweet[];
}

interface TutorialSourceTweet {
  url: string;
  author: string;
  relevance: string;
}

interface TutorialIdea {
  title: string;
  the_hook: string;
  demand_signal: string;
  tweet_count: number;
  source_tweets: TutorialSourceTweet[];
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

async function scrapeTweets(
  keywords: string[],
  maxItems: number,
  filters?: AgentConfigValue['filters'],
): Promise<ApifyTweet[]> {
  // Build search terms using Twitter advanced search syntax.
  // Each keyword becomes its own search term so the actor fetches across all of them.
  const searchTerms = keywords.map((kw) => {
    let term = kw;
    // Add engagement filters to the search query
    if (filters?.minLikes) term += ` min_faves:${filters.minLikes}`;
    if (filters?.minRetweets) term += ` min_retweets:${filters.minRetweets}`;
    if (filters?.minReplies) term += ` min_replies:${filters.minReplies}`;
    if (filters?.onlyVerified) term += ` filter:verified`;
    return term;
  });

  console.log(`Starting Apify tweet scraper with ${searchTerms.length} search terms, maxItems=${maxItems}`);
  console.log('Search terms:', searchTerms);

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
function normalizeTweets(raw: ApifyTweet[], minAuthorFollowers?: number): NormalizedTweet[] {
  console.log(`[normalizeTweets] Starting with ${raw.length} raw tweets`);

  let retweetCount = 0;
  let shortTextCount = 0;
  let wrongTypeCount = 0;
  let lowFollowersCount = 0;

  const filtered = raw.filter((t) => {
    // Skip retweets – they're duplicates
    if (t.isRetweet) { retweetCount++; return false; }
    // Skip tweets with no meaningful text
    if (!t.text || t.text.trim().length < 20) { shortTextCount++; return false; }
    // Only keep tweets typed as "tweet"
    if (t.type !== 'tweet') { wrongTypeCount++; return false; }
    // Filter by minimum author followers
    if (minAuthorFollowers && (t.author?.followers || 0) < minAuthorFollowers) { lowFollowersCount++; return false; }
    return true;
  });

  console.log(`[normalizeTweets] Filtered out: ${retweetCount} retweets, ${shortTextCount} short/empty, ${wrongTypeCount} wrong type, ${lowFollowersCount} low followers`);
  console.log(`[normalizeTweets] Remaining: ${filtered.length} tweets`);

  // Deduplicate by tweet ID
  const uniqueTweets = new Map<string, ApifyTweet>();
  for (const t of filtered) {
    if (!uniqueTweets.has(t.id)) {
      uniqueTweets.set(t.id, t);
    }
  }
  console.log(`[normalizeTweets] After deduplication: ${uniqueTweets.size} unique tweets`);

  return Array.from(uniqueTweets.values())
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
// GPT-4o Model
// ---------------------------------------------------------------------------

const GPT_MODEL = 'gpt-4o';

// ---------------------------------------------------------------------------
// Helper: format tweets for prompt
// ---------------------------------------------------------------------------

function formatTweetsForPrompt(tweets: NormalizedTweet[]): string {
  return tweets
    .map((t, i) => {
      const engagement = t.likes + t.retweets + t.replies;
      const truncatedText = t.text.length > 500 ? t.text.slice(0, 500) + '...' : t.text;
      return `${i + 1}. @${t.author} (${t.author_followers.toLocaleString()} followers) [engagement: ${engagement}]
URL: ${t.url}
Posted: ${t.created_at}
"${truncatedText}"`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Focused Analysis: Comment Opportunities
// ---------------------------------------------------------------------------

const commentOpportunitiesSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'Only the TOP 3-5 BEST opportunities. Quality over quantity. Return fewer if there are not enough high-quality matches.',
      items: {
        type: 'object',
        properties: {
          tweet_text: { type: 'string', description: 'Truncated tweet text (max 200 chars)' },
          tweet_url: { type: 'string', description: 'URL to the tweet' },
          author: { type: 'string', description: 'Twitter handle of the author' },
          author_followers: { type: 'number', description: 'Follower count of the author' },
          why_comment: { type: 'string', description: 'Why this is a HIGH-IMPACT opportunity — what makes it worth commenting on' },
          draft_comment: { type: 'string', description: 'A ready-to-use draft comment (will be edited by human before posting)' },
          engagement_score: { type: 'number', description: 'Combined engagement (likes + retweets + replies)' },
        },
        required: ['tweet_text', 'tweet_url', 'author', 'author_followers', 'why_comment', 'draft_comment', 'engagement_score'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

async function analyzeCommentOpportunities(tweets: NormalizedTweet[], config: AgentConfigValue): Promise<CommentOpportunity[]> {
  const tweetList = formatTweetsForPrompt(tweets);

  const systemPrompt = `You are a strategic Twitter growth advisor for ${config.companyName} (${config.companyWebsite}).

${config.companyDescription}

Context about the founder:
${config.founderContext}

Your job: Find 3-5 tweets where a smart comment could convert the author or their audience into followers. We want people who see our comment to think "this person gets it, I should follow them."

## The GOAL of each comment:
Turn readers into followers by demonstrating expertise, personality, or both.

## IDEAL tweet targets:

### 1. Our exact audience discussing our exact problem
- Developers struggling with agent memory, state, observability
- People building AI agents and hitting the walls we solve
- Questions about how to track/debug/monitor agents in production
- Frustration posts about problems ${config.companyName} addresses
→ Comment with genuine expertise that makes them want to know more

### 2. Influential people in our space
- AI/agent builders with large followings discussing relevant topics
- Developer advocates, founders, engineers at AI companies
- People whose followers are our target users
→ Comment something smart/funny that gets their attention + shows we know our stuff

### 3. Viral conversations about our domain
- Hot debates about AI agents, LLMs in production, agent frameworks
- Trending threads where our perspective would stand out
→ Comment with a unique angle that positions us as experts

## What makes a FOLLOW-WORTHY comment:
- Shows deep expertise without being preachy
- Has personality — witty, direct, or refreshingly honest
- Adds something nobody else in the replies said
- Makes people curious about who wrote it
- Short and punchy (1-2 sentences)

## SKIP these:
- Tweets with no connection to AI agents, developer tools, or production infrastructure
- Generic AI hype with audiences that aren't developers
- Topics where we can't demonstrate relevant expertise
- Anything where we'd sound like every other reply
- **News accounts and publications** (TechCrunch, VentureBeat, TheVerge, Wired, etc.)
- **Brand/company accounts** (official accounts of companies, not individual employees)
- **Bot-like accounts** or automated news aggregators
- **Accounts that just repost headlines** without original commentary

## ONLY target REAL HUMANS:
- Individual developers, founders, engineers with personal accounts
- People sharing their own experiences, opinions, or projects
- Accounts where a real person is clearly behind the tweets
- Look for signs of personality: opinions, jokes, personal projects, complaints

## NEVER:
- Write generic agreement ("So true!", "This is the way")
- Sound like a LinkedIn post
- Force a mention of ${config.companyName} — only if genuinely natural
- Use hashtags or excessive emojis

## Output:
Return 3-5 opportunities where our comment could realistically earn followers. Quality over quantity — 0 is fine if nothing fits.
${config.customInstructions ? `\n## Additional Instructions:\n${config.customInstructions}` : ''}`;

  const response = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Find the best comment opportunities from these ${tweets.length} tweets:\n\n${tweetList}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'comment_opportunities', strict: true, schema: commentOpportunitiesSchema },
    },
  });

  const result = JSON.parse(response.choices[0].message.content || '{"items":[]}');
  return result.items as CommentOpportunity[];
}

// ---------------------------------------------------------------------------
// Focused Analysis: Trends
// ---------------------------------------------------------------------------

const trendsSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'Only 2-4 REAL trends backed by many tweets. Return fewer or zero if no real trends exist.',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'Clear trend name (tool, technology, technique, or topic)' },
          tweet_count: { type: 'number', description: 'Approximate number of tweets in the dataset discussing this trend' },
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
            description: '3-5 example tweets showing this trend',
          },
          why_trending: { type: 'string', description: 'Why is this trending NOW? What triggered it?' },
          sentiment: { type: 'string', enum: ['hype', 'frustration', 'curiosity', 'fatigue', 'debate'], description: 'Overall sentiment' },
          company_relevance: { type: 'string', description: 'How this relates to the company — be honest when it does not' },
        },
        required: ['theme', 'tweet_count', 'evidence_tweets', 'why_trending', 'sentiment', 'company_relevance'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

async function analyzeTrends(tweets: NormalizedTweet[], config: AgentConfigValue): Promise<Trend[]> {
  const tweetList = formatTweetsForPrompt(tweets);

  const systemPrompt = `You are a trend analyst looking for REAL trends in Twitter data for ${config.companyName} (${config.companyWebsite}).

${config.companyDescription}

Your job: Find REAL trends — topics that MANY people are discussing, not just a few tweets.

## What counts as a REAL trend:
- A tool/product that multiple people are talking about (e.g., "Everyone's trying Claude's new computer use feature")
- A technology or technique gaining traction (e.g., "MCP servers are exploding in popularity")
- A new way of doing things spreading through the community (e.g., "Developers moving from LangChain to lighter frameworks")
- A debate or controversy many people are weighing in on
- A problem multiple people are independently complaining about

## STRICT requirements:
- Must appear in AT LEAST 5-10+ tweets in the dataset to be a trend
- Multiple different authors discussing the same thing
- Not just one viral tweet — actual pattern across the data

## NOT a trend:
- A single tweet, even if viral
- Generic topics that are always discussed (e.g., "AI is useful")
- Things only 1-2 people mentioned
- Vague themes you can't point to specific evidence for

## For each trend:
- Name it specifically (tool name, technique, debate topic)
- Count approximately how many tweets discuss it
- Include 3-5 evidence tweets from DIFFERENT authors
- Explain WHY it's trending now (what triggered it?)
- Assess sentiment: hype, frustration, curiosity, fatigue, or debate

## Output:
Return only 2-4 REAL trends. If the data doesn't have clear trends, return fewer or zero. Quality over quantity — don't invent trends that aren't there.
${config.customInstructions ? `\n## Additional Instructions:\n${config.customInstructions}` : ''}`;

  const response = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Identify the key trends from these ${tweets.length} tweets:\n\n${tweetList}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'trends', strict: true, schema: trendsSchema },
    },
  });

  const result = JSON.parse(response.choices[0].message.content || '{"items":[]}');
  return result.items as Trend[];
}

// ---------------------------------------------------------------------------
// Focused Analysis: New Tools & Companies
// ---------------------------------------------------------------------------

const toolsSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'New products, tools, launches, or repos mentioned.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Product or tool name' },
          description: { type: 'string', description: 'What it does in one line' },
          url: { type: 'string', description: 'Link to the tool/product website or repo' },
          relationship: { type: 'string', enum: ['competitor', 'potential_partner', 'complementary', 'irrelevant'], description: 'Relationship to the company' },
          company_relevance: { type: 'string', description: 'One line on how it relates to the company space' },
          source_tweets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL to the tweet that mentioned this tool' },
                author: { type: 'string', description: 'Twitter handle of the author' },
              },
              required: ['url', 'author'],
              additionalProperties: false,
            },
            description: 'Tweets that mentioned this tool/company',
          },
        },
        required: ['name', 'description', 'url', 'relationship', 'company_relevance', 'source_tweets'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

async function analyzeTools(tweets: NormalizedTweet[], config: AgentConfigValue): Promise<NewTool[]> {
  const tweetList = formatTweetsForPrompt(tweets);

  const systemPrompt = `You are a competitive intelligence agent for ${config.companyName} (${config.companyWebsite}).

${config.companyDescription}

Your ONLY job: Find NEW TOOLS, PRODUCTS, and COMPANIES mentioned in the Twitter data.

## What to look for:
- Product launches and announcements
- GitHub repos being shared
- New startups or tools people are excited about
- Existing tools getting significant updates
- Open source projects gaining traction

## For each tool found:
- Extract the actual name and URL (from the tweet or infer from context)
- Describe what it does in one clear sentence
- Classify relationship to ${config.companyName}: competitor, potential_partner, complementary, or irrelevant
- Include the source tweets where you found it

## Rules:
- Only include actual products/tools, not concepts or ideas
- Must have a real URL (website, GitHub, etc.)
- Focus on things relevant to AI agents, developer tools, infrastructure
- Don't include well-known established tools unless there's news about them
${config.customInstructions ? `\n## Additional Instructions:\n${config.customInstructions}` : ''}`;

  const response = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Find new tools and products mentioned in these ${tweets.length} tweets:\n\n${tweetList}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'tools', strict: true, schema: toolsSchema },
    },
  });

  const result = JSON.parse(response.choices[0].message.content || '{"items":[]}');
  return result.items as NewTool[];
}

// ---------------------------------------------------------------------------
// Focused Analysis: Tutorial Ideas
// ---------------------------------------------------------------------------

const tutorialsSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'Only 2-3 SPECIFIC, CONCRETE tutorial ideas with proven demand. Return fewer or zero if nothing qualifies.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Very specific tutorial title with concrete outcome (e.g., "Build a Slack bot that summarizes GitHub PRs and posts daily standups")' },
          the_hook: { type: 'string', description: 'One sentence that would make a developer click — the exciting/useful outcome' },
          demand_signal: { type: 'string', description: 'What evidence shows people actually want this? (e.g., "15+ tweets asking how to do X" or "Multiple devs sharing failed attempts at Y")' },
          tweet_count: { type: 'number', description: 'Approximate number of tweets showing demand for this topic' },
          source_tweets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL to the tweet' },
                author: { type: 'string', description: 'Twitter handle' },
                relevance: { type: 'string', description: 'How this tweet shows demand (question asked, problem shared, etc.)' },
              },
              required: ['url', 'author', 'relevance'],
              additionalProperties: false,
            },
            description: '3-5 tweets proving demand for this tutorial',
          },
          outline: {
            type: 'array',
            items: { type: 'string' },
            description: '4-6 specific steps with concrete details',
          },
          effort: { type: 'string', enum: ['quick', 'medium', 'deep'], description: 'quick (2-3hr), medium (half day), deep (full day+)' },
        },
        required: ['title', 'the_hook', 'demand_signal', 'tweet_count', 'source_tweets', 'outline', 'effort'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

async function analyzeTutorials(tweets: NormalizedTweet[], config: AgentConfigValue): Promise<TutorialIdea[]> {
  const tweetList = formatTweetsForPrompt(tweets);

  const systemPrompt = `You are a developer content strategist who only creates tutorials with PROVEN DEMAND.

${config.companyName}: ${config.companyDescription}

Your job: Find 2-3 ULTRA-SPECIFIC tutorial ideas that MANY developers clearly want, based on the tweet data.

## What we're looking for:

### SPECIFIC means:
- NOT: "Build an AI Agent with Memory" 
- YES: "Build a customer support bot that remembers past conversations and escalates to humans when confidence is low"

- NOT: "Session Tracking for Agents"
- YES: "Build a coding assistant that tracks your debugging session and suggests fixes based on what you've already tried"

- NOT: "Agent Observability Tutorial"  
- YES: "Build a Slack bot that alerts you when your AI agent starts hallucinating or goes off-script, with example logs"

The title should describe a COMPLETE, USABLE THING someone can build — not an abstract concept.

### PROVEN DEMAND means:
- Multiple tweets (5+) asking how to do something similar
- Several developers sharing the same struggle or question
- A trending topic where people clearly need guidance
- NOT just 1-2 tweets mentioning something vaguely related

## For each tutorial:
1. **Title**: Ultra-specific, describes concrete end result
2. **The hook**: One exciting sentence that makes devs click
3. **Demand signal**: Explain what in the data proves people want this
4. **Tweet count**: How many tweets show this demand
5. **Source tweets**: 3-5 actual tweets proving the demand (with why each is relevant)
6. **Outline**: 4-6 specific implementation steps

## HARD REQUIREMENTS:
- Must have 5+ tweets showing demand (questions, complaints, failed attempts, requests)
- Must be specific enough that the reader knows exactly what they'll build
- Must naturally use ${config.companyName} (but the tutorial idea should be valuable regardless)

## DO NOT:
- Invent demand that isn't in the data
- Create generic/abstract tutorial ideas
- Force ideas when the data doesn't support them

Return 2-3 ideas MAX. Zero is fine if nothing has enough demand.
${config.customInstructions ? `\n## Additional Instructions:\n${config.customInstructions}` : ''}`;

  const response = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate tutorial ideas based on these ${tweets.length} tweets:\n\n${tweetList}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'tutorials', strict: true, schema: tutorialsSchema },
    },
  });

  const result = JSON.parse(response.choices[0].message.content || '{"items":[]}');
  return result.items as TutorialIdea[];
}

// ---------------------------------------------------------------------------
// Core analysis function - runs all analyses in parallel
// ---------------------------------------------------------------------------

async function analyzeTwitterData(tweets: NormalizedTweet[], config: AgentConfigValue): Promise<AnalysisResult> {
  // Limit tweets to avoid payload size issues - prioritize by engagement
  const sortedTweets = [...tweets]
    .sort((a, b) => (b.likes + b.retweets + b.replies) - (a.likes + a.retweets + a.replies))
    .slice(0, 150); // Increased limit since GPT-4o has better context handling

  console.log(`[analyzeTwitterData] Running 4 focused analyses in parallel on ${sortedTweets.length} tweets...`);

  // Run all analyses in parallel
  const [comment_opportunities, trends, new_tools, tutorial_ideas] = await Promise.all([
    config.sinks.opportunities ? analyzeCommentOpportunities(sortedTweets, config) : Promise.resolve([]),
    config.sinks.trends ? analyzeTrends(sortedTweets, config) : Promise.resolve([]),
    config.sinks.tools ? analyzeTools(sortedTweets, config) : Promise.resolve([]),
    config.sinks.tutorials ? analyzeTutorials(sortedTweets, config) : Promise.resolve([]),
  ]);

  console.log(`[analyzeTwitterData] Analysis complete: ${comment_opportunities.length} opportunities, ${trends.length} trends, ${new_tools.length} tools, ${tutorial_ideas.length} tutorials`);

  return {
    comment_opportunities,
    trends,
    new_tools,
    tutorial_ideas,
    run_summary: `Analyzed ${sortedTweets.length} tweets. Found ${comment_opportunities.length} comment opportunities, ${trends.length} trends, ${new_tools.length} new tools, and ${tutorial_ideas.length} tutorial ideas.`,
  };
}

// ---------------------------------------------------------------------------
// Format Telegram message
// ---------------------------------------------------------------------------

function formatTelegramMessage(analysis: AnalysisResult, companyName: string): string {
  const lines: string[] = [];

  lines.push(`--- ${companyName.toUpperCase()} MARKETING INTEL ---\n`);

  // Comment Opportunities
  if (analysis.comment_opportunities.length > 0) {
    lines.push('TARGET COMMENT OPPORTUNITIES\n');
    for (const opp of analysis.comment_opportunities) {
      lines.push(`  @${opp.author} (${opp.author_followers.toLocaleString()} followers) | engagement: ${opp.engagement_score}`);
      lines.push(`  "${opp.tweet_text}"`);
      lines.push(`  ${opp.tweet_url}`);
      lines.push(`  Why: ${opp.why_comment}`);
      lines.push(`  Draft: ${opp.draft_comment}`);
      lines.push('');
    }
  }

  // Trends
  if (analysis.trends.length > 0) {
    lines.push('TRENDS\n');
    for (const trend of analysis.trends) {
      lines.push(`  ${trend.theme} [${trend.sentiment}] (~${trend.tweet_count} tweets)`);
      lines.push(`  Why trending: ${trend.why_trending}`);
      lines.push(`  ${companyName} relevance: ${trend.company_relevance}`);
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
      lines.push(`  Relationship: ${tool.relationship} | ${tool.company_relevance}`);
      lines.push('');
    }
  }

  // Tutorial Ideas
  if (analysis.tutorial_ideas.length > 0) {
    lines.push('TUTORIAL IDEAS\n');
    for (const idea of analysis.tutorial_ideas) {
      lines.push(`  "${idea.title}" [${idea.effort}] (~${idea.tweet_count} tweets showing demand)`);
      lines.push(`  Hook: ${idea.the_hook}`);
      lines.push(`  Demand: ${idea.demand_signal}`);
      lines.push(`  Outline:`);
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

    if (!config.companyName || !config.companyDescription || !config.founderName || !config.founderContext) {
      return { success: false, reason: 'Missing required config fields: companyName, companyDescription, founderName, founderContext' };
    }

    if (!config.sinks || (!config.sinks.opportunities && !config.sinks.trends && !config.sinks.tools && !config.sinks.tutorials)) {
      return { success: false, reason: 'No sink IDs configured. Set at least one sink ID in the OpenSink agent configuration.' };
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

      const rawTweets = await scrapeTweets(keywords, maxItems, config.filters);
      const tweets = normalizeTweets(rawTweets, config.filters?.minAuthorFollowers);

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

      const analysis = await analyzeTwitterData(tweets, config);

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
      if (analysis.comment_opportunities.length > 0 && config.sinks.opportunities) {
        const oppItems = analysis.comment_opportunities.map((opp) => ({
          sink_id: config.sinks.opportunities,
          title: `@${opp.author}: ${opp.tweet_text.slice(0, 80)}...`,
          body: `Why: ${opp.why_comment}\n\nDraft comment:\n${opp.draft_comment}`,
          url: opp.tweet_url,
          fields: {
            author: opp.author,
            author_followers: opp.author_followers,
            engagement_score: opp.engagement_score,
            draft_comment: opp.draft_comment,
          },
          resources: [
            { type: 'link' as const, label: 'View Tweet', url: opp.tweet_url },
            { type: 'link' as const, label: `${opp.author}'s Profile`, url: `https://twitter.com/${opp.author}` },
          ],
        }));

        console.log('[Comment Opportunities] Creating items with payload:', JSON.stringify(oppItems, null, 2));
        const oppResult = await openSink.sinkItems.createMany(oppItems);
        console.log('[Comment Opportunities] API response:', JSON.stringify(oppResult.data, null, 2));

        await logActivity(
          session.data.id,
          AGENT_ID,
          AgentSessionActivityType.SINK_ITEM_CREATED,
          AgentSessionActivitySource.AGENT,
          `Created ${oppResult.data.created.length} comment opportunity items`,
        );
      }

      // 2. Trends
      if (analysis.trends.length > 0 && config.sinks.trends) {
        const trendItems = analysis.trends.map((trend) => ({
          sink_id: config.sinks.trends,
          title: `${trend.theme} [${trend.sentiment}] (~${trend.tweet_count} tweets)`,
          body: `Why trending: ${trend.why_trending}\n\nEvidence: ${trend.evidence_tweets.map((e) => `@${e.author}: "${e.text}"`).join(' | ')}\n\n${config.companyName} relevance: ${trend.company_relevance}`,
          fields: {
            sentiment: trend.sentiment,
            tweet_count: trend.tweet_count,
            why_trending: trend.why_trending,
            company_relevance: trend.company_relevance,
          },
          resources: trend.evidence_tweets.map((e) => ({
            type: 'link' as const,
            label: `${e.author}'s Tweet`,
            url: e.url,
          })),
        }));

        console.log('[Trends] Creating items with payload:', JSON.stringify(trendItems, null, 2));
        const trendResult = await openSink.sinkItems.createMany(trendItems);
        console.log('[Trends] API response:', JSON.stringify(trendResult.data, null, 2));

        await logActivity(
          session.data.id,
          AGENT_ID,
          AgentSessionActivityType.SINK_ITEM_CREATED,
          AgentSessionActivitySource.AGENT,
          `Created ${trendResult.data.created.length} trend items`,
        );
      }

      // 3. New Tools & Companies
      if (analysis.new_tools.length > 0 && config.sinks.tools) {
        const toolItems = analysis.new_tools.map((tool) => ({
          sink_id: config.sinks.tools,
          title: tool.name,
          body: `${tool.description}\n${tool.company_relevance}`,
          url: tool.url,
          fields: {
            relationship: tool.relationship,
            company_relevance: tool.company_relevance,
          },
          resources: tool.source_tweets.map((t) => ({
            type: 'link' as const,
            label: `${t.author}'s Tweet`,
            url: t.url,
          })),
        }));

        console.log('[Tools] Creating items with payload:', JSON.stringify(toolItems, null, 2));
        const toolResult = await openSink.sinkItems.createMany(toolItems);
        console.log('[Tools] API response:', JSON.stringify(toolResult.data, null, 2));

        await logActivity(
          session.data.id,
          AGENT_ID,
          AgentSessionActivityType.SINK_ITEM_CREATED,
          AgentSessionActivitySource.AGENT,
          `Created ${toolResult.data.created.length} new tool items`,
        );
      }

      // 4. Tutorial Ideas
      if (analysis.tutorial_ideas.length > 0 && config.sinks.tutorials) {
        const tutorialItems = analysis.tutorial_ideas.map((idea) => ({
          sink_id: config.sinks.tutorials,
          title: idea.title,
          body: `${idea.the_hook}\n\nDemand (${idea.tweet_count} tweets): ${idea.demand_signal}\n\nOutline:\n${idea.outline.map((b) => `- ${b}`).join('\n')}`,
          fields: {
            effort: idea.effort,
            the_hook: idea.the_hook,
            demand_signal: idea.demand_signal,
            tweet_count: idea.tweet_count,
          },
          resources: idea.source_tweets.map((t) => ({
            type: 'link' as const,
            label: `${t.author}: ${t.relevance}`,
            url: t.url,
          })),
        }));

        console.log('[Tutorials] Creating items with payload:', JSON.stringify(tutorialItems, null, 2));
        const tutorialResult = await openSink.sinkItems.createMany(tutorialItems);
        console.log('[Tutorials] API response:', JSON.stringify(tutorialResult.data, null, 2));

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

      const telegramMessage = formatTelegramMessage(analysis, config.companyName);

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
