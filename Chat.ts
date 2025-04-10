import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { HttpTool } from "./HttpTool";

// Message type definition (OpenAI compatible)
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  content: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

// Chat session data stored in DO
interface ChatSession {
  systemPrompt?: string;
  lastUsed: number;
  // We don't store the agent instance itself as it's not serializable
  // Instead we'll recreate it when needed
}

// Request body interface for OpenAI-compatible API
export interface ChatRequestBody {
  messages?: Message[];
  message?: string;
  stream?: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  projectId?: string; // For backward compatibility
  [key: string]: any; // Allow other properties
}

/**
 * Chat Durable Object 
 * Handles persistent chat sessions across worker instances
 */
export class Chat {
  private storage: DurableObjectStorage;
  private env: Env;
  private session: ChatSession | null = null;
  private agent: Agent | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
  }

  /**
   * Main entry point for the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    // Only handle POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Load session data
      await this.loadSession();

      // Parse request body
      const body = await request.json() as ChatRequestBody;

      // Extract messages from request body
      let messages: Message[] = [];
      
      if (body.messages && Array.isArray(body.messages)) {
        messages = body.messages;
      } else if (body.message) {
        messages = [{ role: 'user', content: body.message }];
      } else {
        return new Response(JSON.stringify({
          error: {
            message: 'Message content is required',
            type: 'invalid_request_error',
            code: 'invalid_message'
          }
        }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Extract system message if present
      const systemMessages = messages.filter(msg => msg.role === 'system');
      const systemPrompt = systemMessages.length > 0 ? systemMessages[0].content : '';
      
      // Update system prompt if changed
      if (systemPrompt && (!this.session?.systemPrompt || this.session.systemPrompt !== systemPrompt)) {
        this.session = {
          ...this.session,
          systemPrompt,
          lastUsed: Date.now()
        };
        await this.saveSession();
      }

      // Get or create agent
      const agent = await this.getAgent(systemPrompt || this.session?.systemPrompt || '');

      // Prepare prompt from messages
      const prompt = messages.map(msg => {
        const prefix = msg.role === 'user' ? 'User: ' : 
                     msg.role === 'assistant' ? 'Assistant: ' : 
                     msg.role === 'system' ? 'System: ' : '';
        return `${prefix}${msg.content}`;
      }).join('\n\n');

      // Update last used timestamp
      this.session = {
        ...this.session,
        lastUsed: Date.now()
      };
      await this.saveSession();

      // Check if streaming is requested
      if (body.stream === true) {
        return this.handleStreamingResponse(agent, prompt);
      } else {
        return this.handleStandardResponse(agent, prompt);
      }
    } catch (error) {
      console.error('Error generating chat response:', error);
      return new Response(JSON.stringify({
        error: {
          message: 'Failed to generate chat response',
          type: 'server_error',
          code: 'processing_error',
          details: error instanceof Error ? error.message : String(error)
        }
      }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * Load session data from storage
   */
  private async loadSession(): Promise<void> {
    // Try to load existing session
    const session = await this.storage.get<ChatSession>('session');
    
    if (session) {
      this.session = session;
    } else {
      // Create a new session if none exists
      this.session = {
        lastUsed: Date.now()
      };
      await this.saveSession();
    }
  }

  /**
   * Save session data to storage
   */
  private async saveSession(): Promise<void> {
    if (this.session) {
      await this.storage.put('session', this.session);
    }
  }

  /**
   * Get or create agent for this session
   */
  private async getAgent(instructions: string): Promise<Agent> {
    // We always create a fresh agent instance since agent state isn't persistable
    // The conversation state is maintained through the prompt construction
    this.agent = new Agent({
      name: "Chat Agent",
      instructions,
      model: openai(this.env.MODEL_NAME || "gpt-4o-2024-11-20"),
      tools: { HttpTool },
    });
    
    return this.agent;
  }

  /**
   * Handle streaming response
   */
  private handleStreamingResponse(agent: Agent, prompt: string): Response {
    // Generate unique stream ID
    const streamId = 'chatcmpl-' + Date.now().toString(36);
    
    // Stream response
    const responsePromise = agent.stream(prompt);
    
    // Create response stream
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        
        try {
          // Get the response
          const response = await responsePromise;
          
          // Send initial role message
          controller.enqueue(encoder.encode(formatStreamingData('', streamId)));
          
          // Process streaming response
          for await (const part of response.fullStream) {
            if (part.type === 'text-delta') {
              // Handle text content
              controller.enqueue(encoder.encode(formatStreamingData(part.textDelta, streamId)));
            } 
            // Handle tool events
            else if (['tool-call', 'tool-call-streaming-start', 'tool-result'].includes(part.type)) {
              const formattedData = handleToolEvent(part.type, part, streamId);
              if (formattedData) {
                controller.enqueue(encoder.encode(formattedData));
              }
            }
          }
          
          // Send completion
          controller.enqueue(encoder.encode(formatStreamingData('', streamId, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          // Handle error in stream
          controller.enqueue(encoder.encode(formatStreamingData('\n\n[Error occurred]', streamId)));
          controller.enqueue(encoder.encode(formatStreamingData('', streamId, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          controller.close();
        }
      }
    });
    
    // Return response with proper headers
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  /**
   * Handle standard (non-streaming) response
   */
  private async handleStandardResponse(agent: Agent, prompt: string): Promise<Response> {
    // Generate non-streaming response
    const response = await agent.generate(prompt);
    const responseText = response.text;
    
    // Calculate token estimates
    const inputTokens = prompt.length / 4; // Very rough estimate
    const outputTokens = responseText.length / 4; // Very rough estimate
    
    // Return standard OpenAI format response
    return new Response(JSON.stringify({
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.env.MODEL_NAME || 'gpt-4o-2024-11-20',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: responseText
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.round(inputTokens),
        completion_tokens: Math.round(outputTokens),
        total_tokens: Math.round(inputTokens + outputTokens)
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Format SSE streaming data in OpenAI format
function formatStreamingData(content: string, id: string, finishReason: string | null = null): string {
  const data = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-4o-2024-11-20",
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason
    }]
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Handle tool events for streaming
function handleToolEvent(eventType: string, part: any, streamId: string): string | null {
  switch (eventType) {
    case 'tool-call':
    case 'tool-call-streaming-start': {
      const toolName = part.toolName || (part as any).toolCall?.name || "unknown";
      return formatStreamingData(`\n\n🔧 ${toolName} ⏳`, streamId);
    }
    case 'tool-result': {
      return formatStreamingData(`\n\n✅ ${part.toolName} ✓`, streamId);
    }
    default:
      return null;
  }
}

// Worker environment type definition
interface Env {
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
} 