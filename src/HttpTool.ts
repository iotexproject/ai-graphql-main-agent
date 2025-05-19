import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from 'axios';
import { KVCache } from "./utils/kv";

/**
 * 生成HTTP请求的缓存键
 * 根据请求参数创建唯一的缓存键
 */
function generateCacheKey(url: string, method: string, headers: Record<string, string>, body?: any, params?: Record<string, string>): string {
  // 创建一个包含所有请求参数的对象
  const requestData = {
    url,
    method,
    headers,
    body,
    params
  };

  // 将对象转换为JSON字符串，然后创建缓存键
  return `http_cache_${Buffer.from(JSON.stringify(requestData)).toString('base64')}`;
}

export const HttpTool = createTool({
  id: "http-request",
  description: "Make HTTP requests to external APIs",
  inputSchema: z.object({
    url: z.string().describe("The URL to make the request to"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET").describe("The HTTP method to use"),
    headers: z.record(z.string()).optional().describe("HTTP headers to include in the request"),
    body: z.any().optional().describe("The request body (for POST, PUT, etc.)"),
    params: z.record(z.string()).optional().describe("URL query parameters"),
  }),
  outputSchema: z.object({
    // status: z.number().describe("HTTP status code"),
    // statusText: z.string().describe("HTTP status text"),
    data: z.any().describe("Response data"),
    // headers: z.record(z.string()).describe("Response headers"),
  }),
  execute: async ({ context }) => {
    try {
      // Extract parameters from context
      let { url, method, headers = {}, body, params } = context;
      console.log({ url, method, headers, params });
      console.log((body), 'HTTP BODY!!!!!!!!!!!!!!!!!');
      if (body.headers) {
        headers = body.headers;
      }
      // 生成缓存键
      const cacheKey = generateCacheKey(url, method, headers, body, params);

      // 使用KVCache包装axios请求，缓存60秒
      return await KVCache.wrap(
        cacheKey,
        async () => {
          // Make the request with axios
          const response = await axios({
            url,
            method,
            headers: {
              'Content-Type': 'application/json',
              ...headers,
            },
            data: body,
            params
          });

          console.log(JSON.stringify(response.data), 'HTTP RES!!!!!!!!!!!!!!!!!');
          return {
            data: response.data,
          };
        },
        {
          ttl: 60, // 缓存60秒
          logHits: true, // 记录缓存命中日志
        }
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Handle Axios errors nicely with response info if available
        if (error.response) {
          return {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data,
            headers: error.response.headers as Record<string, string>,
          };
        }
        throw new Error(`HTTP request failed: ${error.message}`);
      }
      if (error instanceof Error) {
        throw new Error(`HTTP request failed: ${error.message}`);
      }
      throw new Error('HTTP request failed with unknown error');
    }
  },
}); 