import { type Context, type Next } from "hono";
import { getApiKeyManager } from "../utils/apikey";
import type { UserSession } from "../storage/UserSession";
import { updateRateLimit, setRateLimitHeaders, shouldSkipCounting, checkRateLimit } from "../middleware/ratelimit";
import type { RateLimitOptions } from "../middleware/ratelimit";
import { createKVStore } from "../middleware/ratelimit";

// Worker environment type definition
interface Env {
  OPENROUTER_API_KEY: string;
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string;
  CHAT_CACHE?: KVNamespace;
  Chat: DurableObjectNamespace;
  POLAR_ACCESS_TOKEN?: string;
  GATEWAY_PROJECT_ID: string;
  USERSESSION: DurableObjectNamespace<UserSession>;
}

/**
 * API Key认证中间件
 */
export const apiKeyMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const kvStore = createKVStore(c.env.CHAT_CACHE as KVNamespace);

  const options: RateLimitOptions = {
    windowMs: 60 * 1000, // 1 分钟
    max: 1, // 每分钟最多 100 次请求
    store: kvStore,
    headers: true,
  };

  // 检查速率限制
  const rateLimitResult = await checkRateLimit(c, options);

  // 设置响应头部
  setRateLimitHeaders(c, rateLimitResult, options);

  // 如果超过限制，则根据apikey进行验证
  if (!rateLimitResult.success) {

    // Extract token from Authorization header
    const authHeader = c.req.header("Authorization") || "";
    let token = "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
    if (!token) {
      return c.json(
        {
          error: {
            message: "Authentication error: Missing API Key",
            type: "authentication_error",
            code: "invalid_parameters",
          },
        },
        401
      );
    }
    // const projectId = c.req.param("projectId")!
    // if (!projectId) {
    //   return c.json(
    //     {
    //       error: {
    //         message: "Missing Project ID",
    //         type: "authentication_error",
    //         code: "invalid_parameters",
    //       },
    //     },
    //     400
    //   );
    // }
    // const projectPrice = await KVCache.wrap(
    //   `project_price_${projectId}`,
    //   async () => {
    //     const projectPrice = await DB.query(
    //       `SELECT pricing->>'price' as price FROM projects WHERE id = $1`,
    //       [token]
    //     );
    //     return projectPrice?.rows[0]?.price;
    //   },
    //   {
    //     ttl: 60,
    //   }
    // );


    const apikey = token
    const userSessionId = c.env.USERSESSION.idFromName(apikey);
    const userSessionDO = c.env.USERSESSION.get(userSessionId);
    const { orgId } = await userSessionDO.init({ apiKey: apikey });
    if (!orgId) {
      return c.json(
        {
          error: {
            message: "Authentication error: Unauthorized API Key",
            type: "authentication_error",
            code: "invalid_parameters",
          },
        },
        401
      );
    }
    // const cost = projectPrice || 1;
    const cost = 1;
    const apiKeyManager = getApiKeyManager(c.env as any);
    const result = await apiKeyManager.verifyKey({
      resourceId: orgId,
      cost,
      projectSlug: 'quicksilver',
    });
    if (!result.success) {
      return c.json(
        {
          error: {
            message: result.message,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        },
        429
      );
    }
  }
  await next();
  if (rateLimitResult.success) {
    // 请求完成后更新计数（如果需要）
    const skip = shouldSkipCounting(c, options);
    await updateRateLimit(c, options, skip);
  }
}; 