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
          content: `You are a task classifier for an AI assistant. Your job is to determine if a user's message is:

1. **NEW_TASK**: A completely new request or task that is unrelated to the previous conversation (different topic, new goal).
2. **FOLLOW_UP**: A continuation, clarification, refinement, or follow-up question about the SAME topic or task. Same topic = FOLLOW_UP even if the phrasing is different or asks for a different angle (e.g. per month, per person, for company).

CRITICAL RULES:
- If the context is empty (no previous messages), you MUST return NEW_TASK.
- If the user's message is about the SAME topic as the recent conversation (same domain, same goal, just a refinement or sub-question), return FOLLOW_UP.
- Only return NEW_TASK when the user clearly switches to a different topic or a new, unrelated request.

Context from previous conversation (oldest to newest):
${contextStr || 'EMPTY - No previous context'}

Respond ONLY with valid JSON in this exact format:
{
  "type": "NEW_TASK" or "FOLLOW_UP",
  "confidence": 0.0 to 1.0
}

Examples:
- Empty context + any message → NEW_TASK (ALWAYS)
- "hey" with empty context → NEW_TASK
- "Can you also check the pricing?" after discussing a product → FOLLOW_UP
- "What's the per month cost?" or "What about two meals per day?" after a pricing report → FOLLOW_UP
- "We want to hire a private chef for our company" after discussing private chef pricing → FOLLOW_UP (same topic: private chef)
- "What's the average monthly salary for this kind of chef?" after hiring/chef discussion → FOLLOW_UP
- "What's the weather today?" after discussing a product → NEW_TASK (different topic)
- "Thanks!" after receiving a response → FOLLOW_UP
- "What can you do?" after a greeting exchange → FOLLOW_UP
- "Tell me about AI" after "Hey" / "Hello" exchange → FOLLOW_UP`,
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
