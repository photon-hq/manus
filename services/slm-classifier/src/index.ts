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

Your job is to classify the user's message into ONE of these 4 intents:

**INTENTS (choose exactly one):**

1. **NEW_TASK** - User wants to start a NEW task/request for Manus AI agent
   - "Book me a flight to Paris"
   - "Help me write a resume"
   - "Research the best laptops under $1000"
   - "Debug this code: [code]"
   - Any substantial request that requires AI agent work
   - Use when NO conversation context exists OR user is starting a completely new topic

2. **FOLLOW_UP** - User is continuing an EXISTING conversation/task
   - Responding to assistant's questions
   - Adding more details to current request
   - "Yes, do that" / "No, try again"
   - ANY message that relates to recent context
   - **DEFAULT when context exists and message isn't about the service itself**

3. **REVOKE** - ONLY when user types exactly "revoke" (just that word, nothing else)
   - "revoke" → REVOKE
   - "I want to revoke" → GENERAL_QUESTION (not REVOKE!)
   - "disconnect" → GENERAL_QUESTION (not REVOKE!)
   - "delete my data" → GENERAL_QUESTION (not REVOKE!)

4. **GENERAL_QUESTION** - Any question/statement about the service itself
   - "what is photon" / "what can you do" / "how does this work"
   - "help" / "commands" / "status"
   - "add key" / "api key" / "how do I add my key"
   - "I want to disconnect" / "how do I delete my data" / "unsubscribe"
   - "who made this" / "what did you use to communicate"
   - Any meta question about Photon/Manus service (NOT a task for Manus to do)

**ROUTING RULES:**

1. If message is EXACTLY "revoke" (case-insensitive, no other words) → REVOKE
2. If asking about the service, help, status, API key, disconnecting, or how things work → GENERAL_QUESTION
3. If context exists AND message relates to it → FOLLOW_UP
4. If no context OR starting a completely new task → NEW_TASK
5. When in doubt between NEW_TASK and FOLLOW_UP with context → Choose FOLLOW_UP

**Context (oldest to newest):**
${contextStr || 'EMPTY - No previous context'}

**Respond with JSON only:**
{"intent": "NEW_TASK" | "FOLLOW_UP" | "REVOKE" | "GENERAL_QUESTION", "confidence": 0.0 to 1.0, "reasoning": "brief explanation"}`;

    const response = await openrouter.chat.completions.create({
      model: 'google/gemini-2.0-flash-001',
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

    const systemPrompt = `You are Photon, an iMessage bridge to Manus AI. Answer questions about the service helpfully.

**About Photon/Manus:**
- Photon connects iMessage to Manus AI
- Manus is a powerful AI agent that can: browse the web, write code, analyze data, create documents, research topics, book travel, handle complex multi-step tasks
- Users get 3 free tasks, then need to add their Manus API key
- API key setup: Go to https://manus.im/app#settings/integrations/api and copy your key, then paste it here
- No apps to install - just text what you need
- To disconnect/delete data: type "revoke"

**Handle these common queries:**

1. **Help / What can you do:**
   - Explain Manus capabilities (browsing, coding, research, data analysis, etc.)
   - Mention they can just text what they need

2. **Status / Tasks left:**
   - Use the user context provided to tell them their actual status
   - If no context, explain they have 3 free tasks then need API key

3. **API key / Add key / How to connect:**
   - Provide URL: https://manus.im/app#settings/integrations/api
   - Explain to copy the key and paste it directly in this chat

4. **Disconnect / Delete data / Unsubscribe / I want to revoke:**
   - Explain what happens when they revoke (data deleted, disconnected)
   - Tell them to type "revoke" to proceed

5. **What is Photon / Who made this:**
   - Explain Photon bridges iMessage to Manus AI

${context ? `**User context:** ${context}` : ''}

**Response Format:**
- Return JSON with "messages" array (1-4 short messages, each under 200 chars)
- Be friendly and conversational
- Include URLs when relevant (they'll show as rich previews)
- When suggesting commands, format like: type "revoke" or type "add key"

Example for disconnect question:
{"messages": ["Revoking will disconnect your account and delete all your data.", "To proceed, just type: revoke"]}`;

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
fastify.post('/onboarding-answer', async (request: any, reply: any) => {
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
