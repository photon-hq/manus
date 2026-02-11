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

**CRITICAL: Default to FOLLOW_UP.** Use NEW_TASK ONLY for clearly unrelated topics.

**FOLLOW_UP** = Same conversation thread. Use for (not exhaustive):
- ANY message in an active conversation, including greetings, small talk, or the user's first real request after initial pleasantries
- User stating their actual need/request at ANY point in the conversation (even if preceded by "hey", "how are you", etc.)
- Continuing, clarifying, or refining any previous topic
- Same domain or related topics (e.g., travel → passport; hiring → pricing; cooking → ingredients)
- Reactions, answers, acknowledgments, or follow-up questions
- When the assistant asked "How can I help?" and user NOW states what they want (even if they chatted first)
- Anything that could plausibly belong to this ongoing conversation
- **When in doubt → FOLLOW_UP**

**NEW_TASK** = ONLY for clearly unrelated topics. High bar:
- User explicitly signals topic change: "Anyway...", "Forget that", "Different topic:", "New question:"
- Request is obviously unrelated (e.g., "What's the weather?" in middle of coding discussion; "Book a flight" after recipe exchange)
- User is clearly done with previous topic and starting something with ZERO connection
- **Do NOT use if message could reasonably be same conversation, new angle, or continuation**

**EXAMPLES:**
- Context: "Hello! How can I help?" → "how are you" → "I'm doing well!" → User: "I need help with X" → **FOLLOW_UP** (user stating their actual request in same conversation)
- Context: "Tell me about your trip" → "It was great!" → User: "Can you help me get a passport?" → **FOLLOW_UP** (travel-related)
- Context: "Recipe for pasta?" → "Here's a recipe" → User: "What's the weather in Tokyo?" → **NEW_TASK** (unrelated)

RULES:
1. Empty context → NEW_TASK
2. Non-empty context → **default FOLLOW_UP**. Only return NEW_TASK if message is unambiguously unrelated
3. Unsure or borderline → **FOLLOW_UP**
4. Conversation just started and user states their need → **FOLLOW_UP**

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
