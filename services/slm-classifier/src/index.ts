import Fastify from 'fastify';
import cors from '@fastify/cors';
import OpenAI from 'openai';
import {
  ClassificationRequestSchema,
  ClassificationResponseSchema,
  MessageIntent,
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
    'HTTP-Referer': 'https://photon.codes',
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

// POST /classify - Agentic Router: Classify message intent
fastify.post('/classify', async (request: any, reply: any) => {
  try {
    const body = ClassificationRequestSchema.parse(request.body);
    const { latest_message, last_task_context } = body;

    fastify.log.info({ 
      message: latest_message,
      contextLength: last_task_context.length 
    }, 'Classifying message intent');

    // Build context string
    const contextStr = last_task_context
      .map((msg: { from: string; text: string }) => `${msg.from}: ${msg.text}`)
      .join('\n');
    
    fastify.log.info({ 
      contextStr,
      contextMessages: last_task_context.map((m: { from: string; text: string }) => ({ from: m.from, text: m.text.substring(0, 100) }))
    }, 'Context for classification');

    // Agentic Router Prompt - Routes to the right handler
    const systemPrompt = `You are an intelligent message router for Photon, an iMessage-to-Manus bridge service.

Your job is to classify the user's message into ONE of these 4 intents based on CONVERSATION CONTEXT:

**CORE PRINCIPLE:**
- **NEW_TASK**: User introduces a NEW problem/request that hasn't been discussed yet
- **FOLLOW_UP**: User continues discussing the SAME problem/topic that's already in context
- The key is: "Is the user talking about the same thing as the recent context, or something different?"

**INTENTS (choose exactly one):**

1. **NEW_TASK** - User wants to start a COMPLETELY NEW task/request
   - Introduction of a NEW problem or topic NOT mentioned in recent context
   - User pivots away from current topic to something unrelated
   - Example triggers: "Also...", "By the way...", "Different question...", new subject entirely
   - Use when context is EMPTY OR user clearly introduces a different problem

2. **FOLLOW_UP** - User continues the EXISTING conversation/task
   - Responding to assistant's questions
   - Adding more details to current request
   - Short affirmations or acknowledgments when context exists
   - ANY message that relates to recent context
   - **DEFAULT when context exists and message isn't about the service itself**
   - **If context exists + short/ambiguous message → FOLLOW_UP**
   - User references or builds on what's already being discussed
   - Refinements, additions, or reactions to the ongoing topic
   - Example triggers: "Yes...", "No...", "More specifically...", answering a question asked

3. **REVOKE** - ONLY when user types exactly "revoke" (case-insensitive)
   - Only "revoke" alone, nothing else

4. **GENERAL_QUESTION** - Questions about THIS SERVICE (Photon/Manus/API keys/pricing)
   - Asking how to USE the service
   - Asking ABOUT the service itself
   - NOT asking FOR the service to help with something

**DECISION FRAMEWORK (use this logic):**

Step 1: Is message EXACTLY "revoke"? → REVOKE
Step 2: Is this about the Photon/Manus SERVICE itself? (how it works, pricing, API keys, status) → GENERAL_QUESTION
Step 3: Does context exist?
  - NO context → Must be NEW_TASK
  - YES context → Ask: "Is the user talking about the SAME problem/topic as in the context?"
    - YES, same topic → FOLLOW_UP (default when context exists)
    - NO, different topic → NEW_TASK

**Context Analysis Tips:**
- Look at WHAT was being discussed (the topic/problem)
- Look at the STATE (is it ongoing, was an answer given, is more info needed?)
- If new message addresses the same problem or responds to something in context → FOLLOW_UP
- If new message introduces a completely different topic → NEW_TASK

**Recent Conversation Context (oldest to newest):**
${contextStr || 'EMPTY - No previous messages'}

**User's New Message:**
"${latest_message}"

**Respond with JSON only:**
{"intent": "NEW_TASK" | "FOLLOW_UP" | "REVOKE" | "GENERAL_QUESTION", "confidence": 0.0 to 1.0, "reasoning": "brief explanation of why"}`;

    const response = await openrouter.chat.completions.create({
      model: 'anthropic/claude-4.5-sonnet',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: latest_message },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 150,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from LLM');
    }

    // Parse JSON response - handle potential markdown code blocks
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);
    
    // Normalize: support both 'intent' and 'type' for backwards compatibility
    const intent = parsed.intent || parsed.type;
    const result = {
      intent: intent as MessageIntent,
      confidence: parsed.confidence ?? 0.8,
      reasoning: parsed.reasoning,
    };

    // Validate the intent is valid
    if (!Object.values(MessageIntent).includes(result.intent)) {
      fastify.log.warn({ parsed, result }, 'Invalid intent, defaulting to NEW_TASK');
      result.intent = MessageIntent.NEW_TASK;
      result.confidence = 0.5;
    }

    fastify.log.info({ classification: result }, 'Classification complete');

    return result;
  } catch (error) {
    fastify.log.error(error, 'Classification failed');
    
    // Return default classification on error
    return {
      intent: MessageIntent.NEW_TASK,
      confidence: 0.5,
      reasoning: 'Error during classification, defaulting to NEW_TASK',
    };
  }
});

// POST /answer - AI-generated response for general questions about Photon/Manus
fastify.post('/answer', async (request: any, reply: any) => {
  try {
    const { question, context } = request.body as { question: string; context?: string };

    fastify.log.info({ question }, 'Generating AI answer');

    const systemPrompt = `You are the Photon assistant for the Manus iMessage bridge. Answer questions helpfully and conversationally.

**ABOUT MANUS:**
- Manus is a general-purpose AI agent (now part of Meta) that can handle complex, multi-step tasks
- Capabilities: browse the web, write & run code, create documents/slides, design, build websites, develop apps, research, analyze data, book travel, and more
- Think of it as an AI that can actually DO things, not just chat
- Now accessible via iMessage through Photon - just text what you need!

**ABOUT PHOTON:**
- Photon is the company that built this iMessage bridge to Manus
- Photon builds infrastructure for AI agents to communicate through messaging platforms (iMessage, WhatsApp, Telegram, etc.)
- Website: https://photon.codes
- Photon created the Advanced iMessage Kit - the technology powering this service
- Technical details: https://github.com/photon-hq/advanced-imessage-kit

**WHO MADE THIS:**
- Built by Photon (https://photon.codes)
- Photon specializes in connecting AI agents to messaging interfaces people already use

**PRICING:**
- First 3 tasks are FREE with full access to all features
- After that, connect your own Manus API key to continue
- No subscription through Photon - you just use your Manus account
- Get API key: https://manus.im/app#settings/integrations/api

**PRIVACY & SECURITY:**
- No data is stored by Photon
- Messages are processed and forwarded to Manus, not retained
- Your conversations stay between you and Manus

**LIMITATIONS:**
- No limitations! You can do anything currently possible through Manus
- Same capabilities as using Manus directly

**SUPPORT:**
- Visit: https://manus.photon.codes for help
- Email us at vandit@photon.codes

**COMMANDS:**
- Type "revoke" to disconnect and delete all data

${context ? `**User context:** ${context}` : ''}

**Handle common queries:**
1. "help" / "what can you do" → Explain Manus capabilities naturally, mention they can just text requests
2. "status" / "tasks left" / "how many tasks" → Use the user context provided to give a personalized, friendly status update. Be conversational, not robotic.
3. "add key" / "api key" → Explain naturally: go to https://manus.im/app#settings/integrations/api, copy the key, and paste it here
4. "disconnect" / "revoke" / "delete data" → Explain what happens, then tell them to type "revoke" to proceed
5. "what is photon" / "who made this" → Photon built this bridge, link to https://photon.codes
6. "pricing" / "cost" / "free" → Explain: 3 free tasks to try it out, then connect your own API key
7. "how does this work" / "technical" → Uses Advanced iMessage Kit by Photon, link to GitHub

**Response Format:**
- Return JSON: {"messages": ["msg1", "msg2", ...]}
- 1-4 short messages, each under 200 chars
- Be friendly and conversational
- Include URLs when relevant (they show as rich previews)
- Format commands like: type "revoke"

Example:
{"messages": ["Photon built this iMessage bridge to Manus!", "Learn more at: https://photon.codes"]}`;

    const response = await openrouter.chat.completions.create({
      model: 'anthropic/claude-3.5-sonnet',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from LLM');
    }

    // Parse JSON response
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);
    const messages = parsed.messages || [parsed.message] || ['I can help you with that!'];

    fastify.log.info({ messages }, 'AI answer generated');

    return { messages };
  } catch (error) {
    fastify.log.error(error, 'Answer generation failed');
    
    return {
      messages: [
        "I'm Photon - your bridge to Manus AI through iMessage.",
        "Just text me what you need help with!",
      ],
    };
  }
});

// POST /onboarding-answer - Generate contextual response for first-time user's question + merge with onboarding
fastify.post('/before-onboarding', async (request: any, reply: any) => {
  try {
    const { question } = request.body as { question: string };

    fastify.log.info({ question }, 'Generating onboarding answer');

    const systemPrompt = `You are Photon, welcoming a new user to the Manus iMessage service.

The user just sent their first message to you, and it's a question or statement (not the standard "Send this message to get started!" trigger).

**Your task:**
1. Briefly acknowledge/answer their question in a friendly way
2. Naturally transition into introducing Manus

**About Manus:**
- Powerful AI agent accessible via iMessage
- Can browse web, write code, analyze data, create documents, research, book travel, handle complex tasks
- 3 free tasks, then needs API key
- No apps to install

**Response Format:**
Return JSON with "answer" - a single short message (under 200 chars) that acknowledges their question and hints that you can help.

Example for "what can you do?":
{"answer": "Great question! I can help with all kinds of tasks - let me tell you more."}

Example for "hi":
{"answer": "Hey there! Welcome! Let me tell you what I can do."}

Example for "can you help me book a flight?":
{"answer": "Absolutely! I can help with that. First, let me quickly introduce myself."}`;

    const response = await openrouter.chat.completions.create({
      model: 'anthropic/claude-3.5-sonnet',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from LLM');
    }

    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);
    const answer = parsed.answer || "Welcome! Let me tell you what I can do.";

    fastify.log.info({ answer }, 'Onboarding answer generated');

    return { answer };
  } catch (error) {
    fastify.log.error(error, 'Onboarding answer generation failed');
    
    return {
      answer: "Welcome! Let me tell you what I can do.",
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
