import Fastify from 'fastify';
import cors from '@fastify/cors';
import OpenAI from 'openai';
import {
  ClassificationRequestSchema,
  ClassificationResponseSchema,
  TaskClassification,
} from '@imessage-mcp/shared';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = '0.0.0.0';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY environment variable is required');
  process.exit(1);
}

// Initialize OpenRouter client
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://photon.ai',
    'X-Title': 'Photon iMessage MCP',
  },
});

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

// Register plugins
fastify.register(cors, {
  origin: true,
});

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// POST /classify - Classify message as NEW_TASK or FOLLOW_UP
fastify.post('/classify', async (request, reply) => {
  try {
    const body = ClassificationRequestSchema.parse(request.body);
    const { latest_message, last_task_context } = body;

    fastify.log.info({ 
      message: latest_message,
      contextLength: last_task_context.length 
    }, 'Classifying message');

    // Build context string
    const contextStr = last_task_context
      .map((msg) => `${msg.from}: ${msg.text}`)
      .join('\n');
    
    fastify.log.info({ 
      contextStr,
      contextMessages: last_task_context.map(m => ({ from: m.from, text: m.text.substring(0, 100) }))
    }, 'Context for classification');

    // Call OpenRouter with OpenAI GPT-3.5 Turbo (reliable, fast, cheap)
    const response = await openrouter.chat.completions.create({
      model: 'openai/gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You classify whether the user's latest message is part of the SAME conversation (FOLLOW_UP) or starts a completely NEW and UNRELATED task (NEW_TASK).

**CRITICAL: ALWAYS prefer FOLLOW_UP. NEW_TASK should be EXTREMELY RARE (< 5% of cases).**

**FOLLOW_UP** = Default for ANY message in an ongoing conversation. Use for:
- ANY message after context exists (greetings, questions, requests, statements, reactions)
- User stating their need/request at ANY point (even after small talk like "hey", "how are you")
- ANY topic that has even a REMOTE connection to previous messages
- Related domains: travel → passport → visa → flights → hotels → budget → planning
- Related domains: hiring → pricing → contracts → onboarding → team → culture
- Related domains: coding → debugging → deployment → testing → documentation
- Continuing, clarifying, refining, expanding on ANY previous topic
- Answering assistant's questions or responding to assistant's output
- **If there's ANY previous reference or connection, even loose → FOLLOW_UP**
- **If you can imagine ANY way this relates to the conversation → FOLLOW_UP**
- **When in doubt (which should be 95% of the time) → FOLLOW_UP**

**NEW_TASK** = ONLY for COMPLETELY different, unrelated topics. Extremely high bar:
- User explicitly says: "Forget that", "Different topic:", "New question:", "Nevermind, instead..."
- Request is OBVIOUSLY unrelated with ZERO connection (e.g., "What's the weather in Tokyo?" after discussing code bugs; "Book a flight to Paris" after discussing cooking recipes with no travel context)
- **Even if topics seem different, if there's ANY conceivable connection → FOLLOW_UP**
- **If user previously mentioned anything related → FOLLOW_UP**

**EXAMPLES (all FOLLOW_UP unless stated):**
- "Hello! How can I help?" → "how are you" → "I'm doing well!" → "I need passport for Bali" → **FOLLOW_UP**
- "Tell me about your trip" → "It was great!" → "Can you get a passport?" → **FOLLOW_UP** (travel context)
- "Hiring a chef" → "Here's info" → "What's the budget?" → **FOLLOW_UP** (same topic)
- "Fix my code" → "Here's the fix" → "Can you deploy it?" → **FOLLOW_UP** (same project)
- "Recipe for pasta" → "Here you go" → "What about dessert?" → **FOLLOW_UP** (cooking context)
- "Recipe for pasta" → "Here you go" → "What's 2+2?" → **NEW_TASK** (completely unrelated, no connection)

**GOLDEN RULE: If context exists and message isn't OBVIOUSLY, COMPLETELY unrelated → FOLLOW_UP**

RULES:
1. Empty context → NEW_TASK
2. Non-empty context → **FOLLOW_UP** (95%+ of cases)
3. Only return NEW_TASK if message is COMPLETELY, OBVIOUSLY unrelated with ZERO connection
4. Any doubt, any connection, any relation → **FOLLOW_UP**

Context (oldest to newest):
${contextStr || 'EMPTY - No previous context'}

Respond with JSON only:
{"type": "NEW_TASK" or "FOLLOW_UP", "confidence": 0.0 to 1.0}`,
        },
        {
          role: 'user',
          content: latest_message,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 100,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from LLM');
    }

    const classification = JSON.parse(content);
    const validated = ClassificationResponseSchema.parse(classification);

    fastify.log.info({ classification: validated }, 'Classification complete');

    return validated;
  } catch (error) {
    fastify.log.error(error, 'Classification failed');
    
    // Return default classification on error
    return {
      type: TaskClassification.NEW_TASK,
      confidence: 0.5,
    };
  }
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`SLM Classifier service running on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
const closeGracefully = async (signal: string) => {
  fastify.log.info(`Received ${signal}, closing gracefully`);
  await fastify.close();
  process.exit(0);
};

process.on('SIGINT', () => closeGracefully('SIGINT'));
process.on('SIGTERM', () => closeGracefully('SIGTERM'));

start();
