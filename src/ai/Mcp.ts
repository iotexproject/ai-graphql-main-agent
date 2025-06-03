import { McpAgent } from "agents/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import "zod-openapi/extend";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleSchemaDetails, handleListSchemas } from "../utils/tool-handlers";
import { handleHTTPRequest } from "./httpTool";

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

      // Handle schema list using common function
      const result = await handleListSchemas({
        projectId,
        marketplaceId: "",
        forDescription: true,
        env: this.env,
      });
      
      if (!result.success) {
        throw new Error(result.error);
      }

      return {
        tools: [
          {
            name: "list_schemas",
            description: `${result.remoteSchemasInfo}. Please call list_schemas tool first to get Schema list before calling any other tools.
            If you already know the Schema list in the current conversation, call schema_details tool directly to get detailed information.
            When users ask about this MCP service functionality, please return the description information of list_schemas tool directly.`,
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "schema_details",
            description: "Get detailed information about GraphQL schema fields, including arguments, input and output types",
            inputSchema: {
              type: "object",
              properties: {
                remoteSchemaId: {
                  type: "string",
                  description: "The remoteSchema ID to fetch schema details for",
                },
                queryFields: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description: "List of field names to get details for (can be query or mutation fields)",
                },
              },
              required: ["queryFields"],
            },
          },
          {
            name: "http_request",
            description: "Send HTTP requests to external APIs, including GraphQL endpoints",
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
            // Handle schema list using common function
            const result = await handleListSchemas({
              projectId,
              marketplaceId: "",
              forDescription: false,
              env: this.env,
            });

            if (!result.success) {
              return {
                content: [
                  { type: "text", text: result.error || "Failed to get schema list" },
                ],
              };
            }

            return {
              content: [{ type: "text", text: result.schemaInfo }],
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

        case "schema_details":
          try {
            // Handle schema details using common tool
            const result = await handleSchemaDetails({
              remoteSchemaId: args.remoteSchemaId as string | undefined,
              marketplaceId: "",
              queryFields: Array.isArray(args.queryFields) ? args.queryFields : [],
              env: this.env,
            });

            if (!result.success) {
              return {
                content: [
                  { type: "text", text: `Failed to get schema details: ${result.error}` },
                ],
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result.fieldDetails, null, 2),
                },
              ],
            };
          } catch (error) {
            console.error("SchemaDetails error:", error);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to get schema details: ${error instanceof Error ? error.message : String(error)}`,
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
                    text: `HTTP request failed (${result.status || ""}): ${result.statusText || result.message || "Unknown error"}\n\n${result.data ? JSON.stringify(result.data, null, 2) : ""}`,
                  },
                ],
              };
            }

            return {
              content: [
                { type: "text", text: JSON.stringify(result.data, null, 2) },
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
}