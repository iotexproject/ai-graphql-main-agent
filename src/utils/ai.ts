import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { Context } from "hono";

// Env interface for Cloudflare Workers
interface Env {
  OPENROUTER_API_KEY: string;
  OPENAI_API_KEY: string;
  Chat: DurableObjectNamespace;
  [key: string]: any;
}

export const getAI = (apiKey: string) => {
  return createOpenRouter({
    apiKey,
    baseURL:
      "https://gateway.ai.cloudflare.com/v1/3f724e4b38a30ee9d189654b73a4e87e/quicksilver/openrouter",
  });
};

export async function useSoraModel(c: Context<any>, requestBody: any): Promise<Response> {
  try {
    console.log('useSoraModel', c.env.OPENROUTER_API_KEY)
    const openrouter = getAI(c.env.OPENROUTER_API_KEY);

    // 构建消息内容
    const messages = requestBody.messages || [];
    const prompt = messages.map((msg: any) => {
      const prefix = msg.role === 'user' ? 'User: ' :
        msg.role === 'assistant' ? 'Assistant: ' :
          msg.role === 'system' ? 'System: ' : '';
      return `${prefix}${msg.content}`;
    }).join('\n\n');

    // 检查是否需要流式响应
    if (requestBody.stream === true) {
      const { streamText } = await import("ai");
      console.log('sonar prompt', prompt)
      try {
        const result = streamText({
          model: openrouter.languageModel("perplexity/sonar"),
          prompt: prompt,
          temperature: requestBody.temperature || 0.7,
          maxTokens: requestBody.max_tokens || 1000,
        });

        // 生成流式响应
        const streamId = "chatcmpl-" + Date.now().toString(36);
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            
            try {
              // 发送初始消息
              controller.enqueue(encoder.encode(formatStreamingData("", streamId)));
              
              // 处理流式文本
              for await (const textPart of result.textStream) {
                controller.enqueue(encoder.encode(formatStreamingData(textPart, streamId)));
              }
              
              // 发送结束消息
              controller.enqueue(encoder.encode(formatStreamingData("", streamId, "stop")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (error) {
              console.error("Error in stream processing:", error);
              try {
                controller.enqueue(encoder.encode(formatStreamingData("\n\n[Error occurred]", streamId)));
                controller.enqueue(encoder.encode(formatStreamingData("", streamId, "stop")));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              } catch (e) {
                console.error("Error sending error message:", e);
              }
            } finally {
              try {
                controller.close();
              } catch (e) {
                console.error("Error closing controller:", e);
              }
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      } catch (streamError) {
        console.error("Error setting up stream:", streamError);
        // 如果流式处理失败，回退到非流式响应
        const { generateText } = await import("ai");
        const result = await generateText({
          model: openrouter.languageModel("perplexity/sonar"),
          prompt: prompt,
          temperature: requestBody.temperature || 0.7,
          maxTokens: requestBody.max_tokens || 1000,
        });
        
        return c.json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'perplexity/sonar',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: result.text
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: Math.round(prompt.length / 4),
            completion_tokens: Math.round(result.text.length / 4),
            total_tokens: Math.round((prompt.length + result.text.length) / 4)
          }
        });
      }
    } else {
      // 非流式响应
      const { generateText } = await import("ai");
      
      const result = await generateText({
        model: openrouter.languageModel("perplexity/sonar"),
        prompt: prompt,
        temperature: requestBody.temperature || 0.7,
        maxTokens: requestBody.max_tokens || 1000,
      });
      
      console.log('result', result.text)
      
      // 返回OpenAI格式的响应
      return c.json({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'perplexity/sonar',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.text
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: Math.round(prompt.length / 4),
          completion_tokens: Math.round(result.text.length / 4),
          total_tokens: Math.round((prompt.length + result.text.length) / 4)
        }
      });
    }
  } catch (error) {
    console.error("Error using sora model:", error);
    
    // 返回错误响应
    return c.json({
      error: {
        message: "Error using sora model",
        type: "server_error",
        code: "processing_error",
        details: error instanceof Error ? error.message : String(error),
      },
    }, 500);
  }
}

// 格式化流式数据的辅助函数
function formatStreamingData(
  content: string,
  id: string,
  finishReason: string | null = null
): string {
  const data = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "perplexity/sonar",
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}