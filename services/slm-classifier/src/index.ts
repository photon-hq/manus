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
          content: `You classify whether the user's latest message is part of the SAME conversation (FOLLOW_UP) or starts a NEW task (NEW_TASK). Use NEW_TASK sparingly—only when there is no reasonable way to treat the message as part of the same thread.

**FOLLOW_UP** = Same conversation. Default choice when context exists. Use for:
- Greetings, re-engagement, or casual replies in an ongoing thread.
- The user stating what they want in response to "How can I help?" or "What can I do?", including any concrete request.
- Same domain or natural extension of the topic (e.g. pricing then hiring in that domain).
- Reactions, clarifications, continuations, answers to the assistant, refinements on the same topic.
- Any message that could plausibly or reasonably belong to this conversation.
- When the message is ambiguous or could be a new angle on the same thread → FOLLOW_UP.

**NEW_TASK** = Use only when the message is unambiguously a different topic or request. The bar is high:
- The user has clearly moved on (e.g. "Anyway, ...", "Forget that—", "Different topic:") and started something with no connection to the current thread.
- The request is obviously unrelated (e.g. "What's the weather?" in the middle of a coding discussion; "Book a flight" after a recipe exchange).
- Do NOT use NEW_TASK if the message could reasonably be a follow-up, new angle, or continuation. When in doubt → FOLLOW_UP.

RULES:
1. Empty context → always NEW_TASK.
2. Non-empty context → default to FOLLOW_UP. Return NEW_TASK only when the message is unambiguously and clearly a different topic or request—if it could plausibly be same thread, return FOLLOW_UP.
3. When unsure or borderline, always return FOLLOW_UP.

Context from previous conversation (oldest to newest):
${contextStr || 'EMPTY - No previous context'}

Respond ONLY with valid JSON:
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
