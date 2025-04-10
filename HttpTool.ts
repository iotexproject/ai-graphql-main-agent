import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from 'axios';

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
      const { url, method, headers = {}, body, params } = context;
      console.log({ url, method, headers, body, params });
      
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
      
      // Extract headers into a plain object (axios already returns them as object)
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        responseHeaders[key] = String(value);
      }
      console.log(JSON.stringify(response.data),'HTTP RES!!!!!!!!!!!!!!!!!');
      return {
        // status: response.status,
        // statusText: response.statusText,
        data: response.data,
        // headers: responseHeaders,
      };
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