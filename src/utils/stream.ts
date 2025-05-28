/**
 * Streaming response utilities for handling SSE format
 */

interface StreamErrorOptions {
  message: string;
  type?: string;
  code?: string;
  status?: number;
}

/**
 * Create a streaming error response in SSE format
 */
export function createStreamErrorResponse(options: StreamErrorOptions): Response {
  const {
    message,
    type = "invalid_request_error",
    code = "invalid_parameters",
    status = 400
  } = options;

  const streamId = "chatcmpl-" + Date.now().toString(36);
  const errorData = {
    id: streamId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        delta: { content: `Error: ${message}` },
        finish_reason: "stop",
      },
    ],
  };

  return new Response(
    `data: ${JSON.stringify(errorData)}\n\ndata: [DONE]\n\n`,
    {
      status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    }
  );
}

/**
 * Create a JSON error response for non-streaming requests
 */
export function createJsonErrorResponse(options: StreamErrorOptions): Response {
  const {
    message,
    type = "invalid_request_error", 
    code = "invalid_parameters",
    status = 400
  } = options;

  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        code,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Create appropriate error response based on stream mode
 */
export function createErrorResponse(isStream: boolean, options: StreamErrorOptions): Response {
  return isStream 
    ? createStreamErrorResponse(options)
    : createJsonErrorResponse(options);
} 