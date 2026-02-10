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
          content: `You classify whether the user's latest message belongs to the SAME conversation thread as the context, or starts a NEW thread.

**FOLLOW_UP** = Same thread. The message is part of the ongoing conversation. Include:
- Reactions or comments about content just shared (e.g. "that's good", "i read this", "i like it", "this is great").
- Clarifications or self-corrections ("i mean...", "actually...", "umm...").
- Continuations ("and also...", "one more thing...", "what about...").
- Answers or responses to the assistant's questions.
- Refinements or sub-questions on the same topic (different angle, same subject).
- Any message that could plausibly refer to or continue the context above.

**NEW_TASK** = New thread. Only when the user clearly starts a different, standalone request:
- Explicitly different topic (e.g. "What's the weather?" in the middle of a product discussion).
- A new request that does not reference or build on the previous exchange.

RULES:
1. Empty context (no previous messages) → always NEW_TASK.
2. Non-empty context → prefer FOLLOW_UP. Only return NEW_TASK if the message clearly and unambiguously starts a different topic or new request.
3. When in doubt with non-empty context, return FOLLOW_UP.

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
