import { type Context, type Next } from "hono";
import { getApiKeyManager } from "../utils/apikey";
import type { UserSession } from "../storage/UserSession";
import { updateRateLimit, setRateLimitHeaders, shouldSkipCounting, checkRateLimit } from "../middleware/ratelimit";
import type { RateLimitOptions, RateLimitStore, RateLimitResult, RateLimitRecord } from "../middleware/ratelimit";
import { createKVStore } from "../middleware/ratelimit";
import { DB } from "@/utils/db";
import { KVCache } from "@/utils/kv";

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
  // const kvStore = createKVStore(c.env.CHAT_CACHE as KVNamespace);

  // const options: RateLimitOptions = {
  //   windowMs: 60 *60 * 1000, // 1 min
  //   max: 5, 
  //   store: kvStore,
  //   headers: true,
  // };

  // // 检查速率限制
  // const rateLimitResult = await checkRateLimit(c, options);

  // // 设置响应头部
  // setRateLimitHeaders(c, rateLimitResult, options);

  // 如果超过限制，则根据apikey进行验证
  // if (!rateLimitResult.success) {

  // Extract token from Authorization header first, then from query parameter
  let token = "";

  // Priority 1: Authorization header
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  // Priority 2: Query parameter (for SSE requests)
  if (!token) {
    const authParam = c.req.query("authorization");
    if (authParam) {
      token = authParam;
      console.log("Token extracted from query parameter");
    }
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
  const projectId = c.req.param("projectId")!
  if (!projectId) {
    return c.json(
      {
        error: {
          message: "Missing Project ID",
          type: "authentication_error",
          code: "invalid_parameters",
        },
      },
      400
    );
  }
  const projectPrice = await KVCache.wrap(
    `project_price_${projectId}`,
    async () => {
      const projectPrice = await DB.queryInDO(
        null,
        `SELECT pricing->>'price' as price FROM projects WHERE id = $1`,
        [projectId]
      );
      return projectPrice?.rows[0]?.price;
    },
    {
      ttl: 60,
    }
  );


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
  const cost = projectPrice || 1;
  // const cost = 1;
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
  // }
  await next();
  // if (rateLimitResult.success) {
  //   // 请求完成后更新计数（如果需要）
  //   const skip = shouldSkipCounting(c, options);
  //   await updateRateLimit(c, options, skip);
  // }
};

export const rateLimitMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const kvStore = createKVStore(c.env.CHAT_CACHE as KVNamespace);

  const options: RateLimitOptions = {
    windowMs: 60 * 1000, // 1 min
    max: 10,
    store: kvStore,
    headers: true,
  };
  const rateLimitResult = await checkRateLimit(c, options);
  setRateLimitHeaders(c, rateLimitResult, options);
  if (!rateLimitResult.success) {
    return c.json(
      {
        error: {
          message: "Rate limit exceeded",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
      429
    );
  }
  await next();
  if (rateLimitResult.success) {
    const skip = shouldSkipCounting(c, options);
    await updateRateLimit(c, options, skip);
  }
}

/**
 * 组合认证中间件：API Key必须传入，根据是否有激活订阅决定走API Key认证还是速率限制
 */
export const combinedAuthMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
  let token = "";

  // 提取 token
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  // 从查询参数提取 token (for SSE requests)
  if (!token) {
    const authParam = c.req.query("authorization");
    if (authParam) {
      token = authParam;
      console.log("Token extracted from query parameter");
    }
  }

  // API Key 必须传入
  if (!token) {
    return c.json(
      {
        error: {
          message: "Authentication error: API Key is required",
          type: "authentication_error",
          code: "missing_api_key",
        },
      },
      401
    );
  }

  const projectId = c.req.param("projectId")!;
  if (!projectId) {
    return c.json(
      {
        error: {
          message: "Missing Project ID",
          type: "authentication_error",
          code: "invalid_parameters",
        },
      },
      400
    );
  }

  const apikey = token;
  const userSessionId = c.env.USERSESSION.idFromName(apikey);
  const userSessionDO = c.env.USERSESSION.get(userSessionId);
  const { orgId, userId } = await userSessionDO.init({ apiKey: apikey });

  if (!orgId) {
    return c.json(
      {
        error: {
          message: "Authentication error: Invalid API Key",
          type: "authentication_error",
          code: "invalid_parameters",
        },
      },
      401
    );
  }

  // 检查用户是否有激活的订阅
  const apiKeyManager = getApiKeyManager(c.env as any);
  const hasActiveSubscription = await apiKeyManager.checkActiveSubscription({ resourceId: orgId });
  const projectPrice = await KVCache.wrap(
    `project_price_${projectId}`,
    async () => {
      const projectPrice = await DB.queryInDO(
        null,
        `SELECT pricing->>'price' as price FROM projects WHERE id = $1`,
        [projectId]
      );
      return projectPrice?.rows[0]?.price;
    },
    {
      ttl: 60,
    }
  );

  const cost = projectPrice; // 使用用户修改的固定成本
  if (hasActiveSubscription) {
    // 有激活订阅，进行 API Key 认证
    console.log("User has active subscription, proceeding with API key auth");


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

    // API Key 认证成功，直接继续
    console.log("API Key authentication successful with subscription");
    await next();
  } else {
    // 没有激活订阅，使用API key进行速率限制
    console.log("User has no active subscription, using rate limit with API key");
    return await handleRateLimit(c, next, userId, cost);
  }
};

/**
 * 获取UTC日的开始时间戳
 */
const getUTCDayStart = (date: Date = new Date()): number => {
  const utcDate = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return utcDate.getTime();
};

/**
 * 获取下一个UTC日的开始时间戳
 */
const getNextUTCDayStart = (date: Date = new Date()): number => {
  const nextDay = new Date(date);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return getUTCDayStart(nextDay);
};

/**
 * 自定义基于UTC日重置的速率限制检查
 */
const checkUTCDailyRateLimit = async (
  apiKey: string,
  store: RateLimitStore,
  maxCredits: number = 10,
  cost: number = 1
): Promise<RateLimitResult> => {
  const now = Date.now();
  const utcDayStart = getUTCDayStart();
  const nextUTCDayStart = getNextUTCDayStart();
  const key = `daily_rate_limit:${apiKey}:${utcDayStart}`;

  try {
    const existing = await store.get(key);
    const currentCount = existing ? existing.count : 0;
    const remaining = Math.max(0, maxCredits - currentCount);

    // 检查是否还有足够的credit
    if (currentCount + cost > maxCredits) {
      return {
        success: false,
        limit: maxCredits,
        remaining: remaining,
        resetTime: nextUTCDayStart,
        retryAfter: Math.ceil((nextUTCDayStart - now) / 1000),
        key
      };
    }

    // 消费credit
    const newRecord: RateLimitRecord = {
      count: currentCount + cost,
      resetTime: nextUTCDayStart,
      firstHit: existing?.firstHit || now,
    };

    // 设置TTL为到下一个UTC日开始的秒数
    const ttlSeconds = Math.ceil((nextUTCDayStart - now) / 1000);
    await store.set(key, newRecord, ttlSeconds * 1000); // TTL in milliseconds

    return {
      success: true,
      limit: maxCredits,
      remaining: Math.max(0, maxCredits - newRecord.count),
      resetTime: nextUTCDayStart,
      key
    };
  } catch (error) {
    console.error('UTC daily rate limit check error:', error);
    // 出错时允许通过，但记录错误
    return {
      success: true,
      limit: maxCredits,
      remaining: maxCredits,
      resetTime: nextUTCDayStart,
      key
    };
  }
};

/**
 * 处理速率限制逻辑
 */
const handleRateLimit = async (c: Context<{ Bindings: Env }>, next: Next, apiKey: string, cost: number = 1) => {
  try {
    const kvStore = createKVStore(c.env.CHAT_CACHE as KVNamespace);
    const maxCredits = 10; // 每天10个credit

    const rateLimitResult = await checkUTCDailyRateLimit(apiKey, kvStore, maxCredits, cost);

    // 设置响应头
    c.header('X-RateLimit-Limit', maxCredits.toString());
    c.header('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
    c.header('X-RateLimit-Reset', Math.ceil(rateLimitResult.resetTime / 1000).toString());

    if (!rateLimitResult.success) {
      c.header('Retry-After', rateLimitResult.retryAfter?.toString() || '');
      return c.json(
        {
          error: {
            message: `Rate limit exceeded. Daily limit: ${maxCredits} credits. Try again after UTC midnight.`,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            details: {
              limit: maxCredits,
              remaining: rateLimitResult.remaining,
              resetTime: rateLimitResult.resetTime,
              retryAfter: rateLimitResult.retryAfter
            }
          },
        },
        429
      );
    }

    // 速率限制通过，继续处理请求
    console.log(`Rate limit check passed for API key. Remaining credits: ${rateLimitResult.remaining}`);
    await next();

  } catch (error) {
    console.error("Rate limit check error:", error);
    return c.json(
      {
        error: {
          message: "Rate limit check failed",
          type: "rate_limit_error",
          code: "rate_limit_error",
        },
      },
      500
    );
  }
};