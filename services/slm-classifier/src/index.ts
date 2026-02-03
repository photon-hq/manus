import './tracing';
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

    fastify.log.info({ message: latest_message }, 'Classifying message');

    // Build context string
    const contextStr = last_task_context
      .map((msg) => `${msg.from}: ${msg.text}`)
      .join('\n');

    // Call OpenRouter with Gemini Flash (fast and free)
    const response = await openrouter.chat.completions.create({
      model: 'google/gemini-2.0-flash-exp:free',
      messages: [
        {
          role: 'system',
          content: `You are a task classifier for an AI assistant. Your job is to determine if a user's message is:

1. **NEW_TASK**: A completely new request or task that is unrelated to the previous conversation
2. **FOLLOW_UP**: A continuation, clarification, or follow-up question related to the ongoing task

Context from previous conversation:
${contextStr || 'No previous context'}

Respond ONLY with valid JSON in this exact format:
{
  "type": "NEW_TASK" or "FOLLOW_UP",
  "confidence": 0.0 to 1.0
}

Examples:
- "Can you also check the pricing?" after discussing a product → FOLLOW_UP
- "What's the weather today?" after discussing a product → NEW_TASK
- "Thanks!" after receiving results → FOLLOW_UP
- "Research AI trends" as first message → NEW_TASK`,
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
