import { McpAgent } from "agents/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import "zod-openapi/extend";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleListSchemas } from "../utils/tool-handlers";
import { handleHTTPRequest } from "./httpTool";
import { DB } from "../utils/db";

type Bindings = Env;
type Props = {
  projectId: string;
};
type State = null;

export class MyMCP extends McpAgent<Bindings, State, Props> {
  // @ts-ignore
  server!: Server;

  async init() {
    this.server = new Server(
      {
        name: "Demo",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      console.log(request, "request");
      const projectId = this.props.projectId || "";
      console.log(projectId, "projectId");
      if (!projectId) {
        throw new Error("Missing projectId");
      }

      // Get remote schemas and build flattened API information
      const remoteSchemas = await this.getRemoteSchemas(projectId);
      const apiInfo = this.buildFlattenedAPIInfo(remoteSchemas, projectId);

      return {
        tools: [
          {
            name: "list_schemas",
            description: `Available HTTP APIs for project ${projectId}:

${apiInfo}

You can use the http_request tool to interact with these APIs directly. All APIs are ready to use with the provided endpoints and parameters.

IMPORTANT: Never display actual values of tokens, API keys, authentication credentials, or sensitive headers to users. Always hide sensitive information.`,
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "http_request",
            description: "Send HTTP requests to external APIs based on OpenAPI specifications. IMPORTANT: Never display tokens, API keys, or other sensitive authentication information in responses to users.",
            inputSchema: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  description: "The URL to make the request to",
                },
                method: {
                  type: "string",
                  enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
                  description: "The HTTP method to use",
                },
                headers: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description: "HTTP headers to include in the request",
                },
                body: {
                  type: "object",
                  description: "The request body (for POST, PUT, etc.)",
                },
                params: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description: "URL query parameters",
                },
              },
              required: ["url", "method"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.log(request.params);
      const args = request.params.arguments || {};
      const projectId = this.props.projectId || "";

      if (!projectId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Project ID is required to use tools",
            },
          ],
        };
      }

      switch (request.params.name) {
        case "list_schemas":
          try {
            const remoteSchemas = await this.getRemoteSchemas(projectId);
            const apiInfo = this.buildFlattenedAPIInfo(remoteSchemas, projectId);

            return {
              content: [{ 
                type: "text", 
                text: `${apiInfo}

IMPORTANT: When displaying API information to users, never show actual values of tokens, API keys, authentication credentials, or any sensitive headers. Always replace sensitive values with [HIDDEN] or similar placeholders.`
              }],
            };
          } catch (error) {
            console.error("ListSchema error:", error);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to get schema information: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }

        case "http_request":
          try {
            // Handle HTTP request using common tool
            const result = await handleHTTPRequest({
              url: args.url as string,
              method: args.method as string,
              headers: args.headers as Record<string, string> | undefined,
              body: args.body,
              params: args.params as Record<string, string> | undefined,
              env: this.env,
            });

            if (result.error) {
              return {
                content: [
                  {
                    type: "text",
                    text: `HTTP request failed (${result.status || ""}): ${result.statusText || result.message || "Unknown error"}\n\n${result.data ? JSON.stringify(result.data, null, 2) : ""}

IMPORTANT: If this response contains any tokens, API keys, or sensitive authentication information, do not display them to the user. Replace with [HIDDEN] or similar placeholders.`,
                  },
                ],
              };
            }

            return {
              content: [
                { 
                  type: "text", 
                  text: `${JSON.stringify(result.data, null, 2)}

IMPORTANT: If this response contains any tokens, API keys, or sensitive authentication information, do not display them to the user. Replace with [HIDDEN] or similar placeholders.`
                },
              ],
            };
          } catch (error) {
            console.error("HTTP request error:", error);

            return {
              content: [
                {
                  type: "text",
                  text: `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }

        default:
          return {
            content: [{ type: "text", text: "Tool not found" }],
          };
      }
    });
  }

  /**
   * Get remote schemas for the project
   */
  private async getRemoteSchemas(projectId: string): Promise<any[]> {
    try {
      // Initialize DB similar to chat.ts
      DB.initialize(this.env.DATABASE_URL);
      
      // Get remote schemas directly from database like chat.ts does
      const remoteSchemas = await DB.getRemoteSchemasFromProjectId(projectId);
      return remoteSchemas || [];
    } catch (error) {
      console.error("Error getting remoteSchemas:", error);
      return [];
    }
  }

  /**
   * Build flattened API information similar to chat.ts
   */
  private buildFlattenedAPIInfo(remoteSchemas: any[], projectId: string): string {
    if (remoteSchemas.length === 0) {
      return "No APIs available for this project.";
    }

    let apiInfo = "";
    
    remoteSchemas.forEach(schema => {
      apiInfo += `\n**${schema.name}** (ID: ${schema.id})
Base URL: ${schema.endpoint}
Description: ${schema.description || 'No description available'}
Required Headers:`;
      
      if (schema.headers && Object.keys(schema.headers).length > 0) {
        Object.entries(schema.headers).forEach(([key, value]) => {
          apiInfo += `\n  - ${key}: ${value}`;
        });
      }
      
      // Extract all endpoint information
      if (schema.openApiSpec && schema.openApiSpec.paths) {
        apiInfo += `\n\nEndpoints:`;
        Object.entries(schema.openApiSpec.paths).forEach(([path, pathItem]: [string, any]) => {
          Object.entries(pathItem).forEach(([method, operation]: [string, any]) => {
            if (typeof operation === 'object' && operation.summary) {
              apiInfo += `\n  - ${method.toUpperCase()} ${path}: ${operation.summary}`;
              if (operation.description) {
                apiInfo += `\n    Description: ${operation.description}`;
              }
              if (operation.parameters && operation.parameters.length > 0) {
                apiInfo += `\n    Parameters:`;
                operation.parameters.forEach((param: any) => {
                  apiInfo += `\n      - ${param.name} (${param.in}${param.required ? ', required' : ', optional'}): ${param.description || 'No description'}`;
                });
              }
            }
          });
        });
      }
      
      apiInfo += "\n";
    });

    let headersInfo = "\nDefault Headers to include in requests:\n";
    if (projectId) {
      headersInfo += `- x-project-id: ${projectId}\n`;
    }
    apiInfo += headersInfo;

    return apiInfo;
  }
}