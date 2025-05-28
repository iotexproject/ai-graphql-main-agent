import type { Context } from 'hono';

// 速率限制结果接口
export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
  key: string;
}

// 速率限制记录接口
export interface RateLimitRecord {
  count: number;
  resetTime: number;
  firstHit: number;
}

// 带过期时间的存储值格式
interface StorageValueWithTTL<T> {
  value: T;
  expires: number | null; // 过期时间戳，null 表示永不过期
}

// 存储驱动抽象接口
export interface RateLimitStore {
  get(key: string): Promise<RateLimitRecord | null>;
  set(key: string, record: RateLimitRecord, ttl?: number): Promise<void>;
  increment(key: string, windowMs: number): Promise<RateLimitRecord>;
  reset(key: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// 速率限制配置接口
export interface RateLimitOptions {
  windowMs: number; // 时间窗口（毫秒）
  max: number; // 最大请求数
  keyGenerator?: (c: Context) => string | Promise<string>; // 键生成器
  skipSuccessfulRequests?: boolean; // 是否跳过成功请求
  skipFailedRequests?: boolean; // 是否跳过失败请求
  store: RateLimitStore; // 存储驱动
  headers?: boolean; // 是否添加速率限制头部
  standardHeaders?: boolean; // 是否使用标准头部格式
  legacyHeaders?: boolean; // 是否使用传统头部格式
  message?: string; // 自定义错误消息
  statusCode?: number; // 自定义状态码
}

/**
 * Cloudflare KV 存储实现
 * 
 * 注意：此实现使用自定义 TTL 机制，而不是 Cloudflare KV 的内置 expirationTtl
 * 
 * 优势:
 * 1. 可以在读取时验证过期时间，提供一致的跨存储实现体验
 * 2. 更灵活的过期处理
 * 3. 在读取时可以同时清理过期数据
 * 
 * 每个值存储为: { value: 实际数据, expires: 过期时间戳 }
 */
export class CloudflareKVStore implements RateLimitStore {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<RateLimitRecord | null> {
    try {
      const value = await this.kv.get(key);
      if (!value) return null;
      
      const storedData = JSON.parse(value) as StorageValueWithTTL<RateLimitRecord>;
      
      // 检查是否过期
      if (isExpired(storedData)) {
        // 已过期，删除并返回 null
        this.delete(key).catch(err => console.error('Error deleting expired key:', err));
        return null;
      }
      
      return storedData.value;
    } catch (error) {
      console.error('KV get error:', error);
      return null;
    }
  }

  async set(key: string, record: RateLimitRecord, ttl?: number): Promise<void> {
    try {
      const storageValue = createStorageValueWithTTL(record, ttl);
      await this.kv.put(key, JSON.stringify(storageValue));
    } catch (error) {
      console.error('KV set error:', error);
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitRecord> {
    const now = Date.now();
    const existing = await this.get(key);

    if (!existing || now - existing.firstHit >= windowMs) {
      // 新的时间窗口
      const newRecord: RateLimitRecord = {
        count: 1,
        resetTime: now + windowMs,
        firstHit: now,
      };
      await this.set(key, newRecord, windowMs);
      return newRecord;
    } else {
      // 在当前时间窗口内
      const updatedRecord: RateLimitRecord = {
        ...existing,
        count: existing.count + 1,
      };
      await this.set(key, updatedRecord, Math.max(0, existing.resetTime - now));
      return updatedRecord;
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.kv.delete(key);
    } catch (error) {
      console.error('KV reset error:', error);
    }
  }

  async delete(key: string): Promise<void> {
    await this.reset(key);
  }
}

// 内存存储实现（用于开发和测试）
export class MemoryStore implements RateLimitStore {
  private store = new Map<string, StorageValueWithTTL<RateLimitRecord>>();

  async get(key: string): Promise<RateLimitRecord | null> {
    const storedData = this.store.get(key);
    if (!storedData) return null;

    // 检查是否过期
    if (isExpired(storedData)) {
      // 已过期，删除并返回 null
      this.store.delete(key);
      return null;
    }

    return storedData.value;
  }

  async set(key: string, record: RateLimitRecord, ttl?: number): Promise<void> {
    const storageValue = createStorageValueWithTTL(record, ttl);
    this.store.set(key, storageValue);
  }

  async increment(key: string, windowMs: number): Promise<RateLimitRecord> {
    const now = Date.now();
    const existing = await this.get(key);

    if (!existing || now - existing.firstHit >= windowMs) {
      // 新的时间窗口
      const newRecord: RateLimitRecord = {
        count: 1,
        resetTime: now + windowMs,
        firstHit: now,
      };
      await this.set(key, newRecord, windowMs);
      return newRecord;
    } else {
      // 在当前时间窗口内
      const updatedRecord: RateLimitRecord = {
        ...existing,
        count: existing.count + 1,
      };
      await this.set(key, updatedRecord, Math.max(0, existing.resetTime - now));
      return updatedRecord;
    }
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// Redis 存储实现（示例）
export class RedisStore implements RateLimitStore {
  constructor(private redis: any) {} // 这里可以是 ioredis 实例

  async get(key: string): Promise<RateLimitRecord | null> {
    try {
      const value = await this.redis.get(key);
      if (!value) return null;
      
      const storedData = JSON.parse(value) as StorageValueWithTTL<RateLimitRecord>;
      
      // 检查是否过期
      if (isExpired(storedData)) {
        // 已过期，删除并返回 null
        this.delete(key).catch(err => console.error('Error deleting expired key:', err));
        return null;
      }
      
      return storedData.value;
    } catch (error) {
      console.error('Redis get error:', error);
      return null;
    }
  }

  async set(key: string, record: RateLimitRecord, ttl?: number): Promise<void> {
    try {
      const storageValue = createStorageValueWithTTL(record, ttl);
      await this.redis.set(key, JSON.stringify(storageValue));
    } catch (error) {
      console.error('Redis set error:', error);
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitRecord> {
    const now = Date.now();
    const existing = await this.get(key);

    if (!existing || now - existing.firstHit >= windowMs) {
      // 新的时间窗口
      const newRecord: RateLimitRecord = {
        count: 1,
        resetTime: now + windowMs,
        firstHit: now,
      };
      await this.set(key, newRecord, windowMs);
      return newRecord;
    } else {
      // 在当前时间窗口内
      const updatedRecord: RateLimitRecord = {
        ...existing,
        count: existing.count + 1,
      };
      await this.set(key, updatedRecord, Math.max(0, existing.resetTime - now));
      return updatedRecord;
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      console.error('Redis reset error:', error);
    }
  }

  async delete(key: string): Promise<void> {
    await this.reset(key);
  }
}

// 默认键生成器
const defaultKeyGenerator = (c: Context): string => {
  // 按优先级获取真实 IP
  const ip = c.req.header('CF-Connecting-IP') || 
            c.req.header('X-Forwarded-For')?.split(',')[0].trim() ||
            c.req.header('X-Real-IP') || 
            c.req.header('X-Client-IP') ||
            'unknown';
  return `ratelimit:${ip}`;
};

// 获取客户端真实 IP 的工具函数
export function getClientIP(c: Context): string {
  const headers = [
    'CF-Connecting-IP',    // Cloudflare 提供的真实 IP
    'X-Forwarded-For',     // 代理服务器转发的 IP
    'X-Real-IP',           // Nginx 等代理设置的真实 IP
    'X-Client-IP',         // 其他代理可能使用的头部
    'X-Forwarded',         // 标准转发头部
    'Forwarded-For',       // 另一种转发头部格式
    'Forwarded'            // RFC 7239 标准头部
  ];

  for (const header of headers) {
    const value = c.req.header(header);
    if (value) {
      // X-Forwarded-For 可能包含多个 IP，取第一个
      const ip = value.split(',')[0].trim();
      if (ip && ip !== 'unknown') {
        return ip;
      }
    }
  }

  return 'unknown';
}

// 设置速率限制响应头部
export function setRateLimitHeaders(
  c: Context, 
  result: RateLimitResult, 
  options: RateLimitOptions
): void {
  if (!options.headers) return;

  const now = Date.now();
  const resetTimeSeconds = Math.ceil(result.resetTime / 1000);

  // 标准头部 (draft-6)
  if (options.standardHeaders !== false) {
    c.res.headers.set('RateLimit-Limit', result.limit.toString());
    c.res.headers.set('RateLimit-Remaining', result.remaining.toString());
    c.res.headers.set('RateLimit-Reset', resetTimeSeconds.toString());
    
    if (!result.success && result.retryAfter) {
      c.res.headers.set('RateLimit-Retry-After', Math.ceil(result.retryAfter / 1000).toString());
    }
  }

  // 传统头部 (X-RateLimit-*)
  if (options.legacyHeaders !== false) {
    c.res.headers.set('X-RateLimit-Limit', result.limit.toString());
    c.res.headers.set('X-RateLimit-Remaining', result.remaining.toString());
    c.res.headers.set('X-RateLimit-Reset', resetTimeSeconds.toString());
    
    if (!result.success && result.retryAfter) {
      c.res.headers.set('Retry-After', Math.ceil(result.retryAfter / 1000).toString());
    }
  }
}

// 主要的速率限制检查函数
export async function checkRateLimit(
  c: Context,
  options: RateLimitOptions
): Promise<RateLimitResult> {
  try {
    const {
      windowMs,
      max,
      keyGenerator = defaultKeyGenerator,
      store,
    } = options;

    // 生成键
    const key = await keyGenerator(c);

    // 获取当前记录
    let record = await store.get(key);
    const now = Date.now();

    // 如果记录不存在或已过期，创建新记录
    if (!record || now - record.firstHit >= windowMs) {
      record = {
        count: 0,
        resetTime: now + windowMs,
        firstHit: now,
      };
    }

    // 检查是否超过限制
    const success = record.count < max;
    const remaining = Math.max(0, max - record.count);
    const retryAfter = success ? undefined : record.resetTime - now;

    const result: RateLimitResult = {
      success,
      limit: max,
      remaining,
      resetTime: record.resetTime,
      retryAfter,
      key,
    };

    return result;

  } catch (error) {
    console.error('Rate limit check error:', error);
    // 在出错时返回成功，避免阻塞请求
    return {
      success: true,
      limit: options.max,
      remaining: options.max,
      resetTime: Date.now() + options.windowMs,
      key: 'error',
    };
  }
}

// 更新速率限制计数
export async function updateRateLimit(
  c: Context,
  options: RateLimitOptions,
  shouldSkip: boolean = false
): Promise<RateLimitRecord | null> {
  if (shouldSkip) return null;

  try {
    const { windowMs, keyGenerator = defaultKeyGenerator, store } = options;
    const key = await keyGenerator(c);
    return await store.increment(key, windowMs);
  } catch (error) {
    console.error('Rate limit update error:', error);
    return null;
  }
}

// 检查是否应该跳过计数
export function shouldSkipCounting(
  c: Context,
  options: RateLimitOptions
): boolean {
  const { skipSuccessfulRequests, skipFailedRequests } = options;
  const status = c.res.status;

  return (
    (Boolean(skipSuccessfulRequests) && status >= 200 && status < 400) ||
    (Boolean(skipFailedRequests) && status >= 400)
  );
}

// 工具函数：创建 Cloudflare KV 存储
export function createKVStore(kv: KVNamespace): CloudflareKVStore {
  return new CloudflareKVStore(kv);
}

// 工具函数：创建内存存储
export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}

// 工具函数：创建 Redis 存储
export function createRedisStore(redis: any): RedisStore {
  return new RedisStore(redis);
}

// 预设配置
export const presets = {
  // 严格限制：每分钟 10 次请求
  strict: (store: RateLimitStore): RateLimitOptions => ({
    windowMs: 60 * 1000, // 1 分钟
    max: 10,
    store,
    headers: true,
    standardHeaders: true,
    legacyHeaders: true,
  }),

  // 中等限制：每分钟 100 次请求
  moderate: (store: RateLimitStore): RateLimitOptions => ({
    windowMs: 60 * 1000, // 1 分钟
    max: 100,
    store,
    headers: true,
    standardHeaders: true,
    legacyHeaders: true,
  }),

  // 宽松限制：每分钟 1000 次请求
  lenient: (store: RateLimitStore): RateLimitOptions => ({
    windowMs: 60 * 1000, // 1 分钟
    max: 1000,
    store,
    headers: true,
    standardHeaders: true,
    legacyHeaders: true,
  }),

  // API 限制：每小时 1000 次请求
  api: (store: RateLimitStore): RateLimitOptions => ({
    windowMs: 60 * 60 * 1000, // 1 小时
    max: 1000,
    store,
    headers: true,
    standardHeaders: true,
    legacyHeaders: true,
    keyGenerator: (c: Context) => {
      const apiKey = c.req.header('X-API-Key') || 
                    c.req.header('Authorization')?.replace('Bearer ', '') ||
                    getClientIP(c);
      return `api:${apiKey}`;
    },
  }),

  // 登录限制：每15分钟 5 次请求
  login: (store: RateLimitStore): RateLimitOptions => ({
    windowMs: 15 * 60 * 1000, // 15 分钟
    max: 5,
    store,
    headers: true,
    standardHeaders: true,
    legacyHeaders: true,
    keyGenerator: (c: Context) => {
      const ip = getClientIP(c);
      return `login:${ip}`;
    },
  }),

  // 上传限制：每分钟 3 次请求
  upload: (store: RateLimitStore): RateLimitOptions => ({
    windowMs: 60 * 1000, // 1 分钟
    max: 3,
    store,
    headers: true,
    standardHeaders: true,
    legacyHeaders: true,
    keyGenerator: (c: Context) => {
      const ip = getClientIP(c);
      return `upload:${ip}`;
    },
  }),
};

// 高级工具函数

// 批量重置速率限制
export async function resetRateLimits(
  store: RateLimitStore,
  keys: string[]
): Promise<void> {
  await Promise.all(keys.map(key => store.reset(key)));
}

// 获取速率限制状态
export async function getRateLimitStatus(
  store: RateLimitStore,
  key: string
): Promise<RateLimitRecord | null> {
  return await store.get(key);
}

/**
 * 检查记录是否已过期
 * 
 * @param storedData 存储的数据
 * @returns 如果记录已过期则返回 true，否则返回 false
 */
export function isExpired<T>(storedData: StorageValueWithTTL<T> | null): boolean {
  if (!storedData) return true;
  return storedData.expires !== null && Date.now() > storedData.expires;
}

/**
 * 创建带 TTL 的存储值
 * 
 * @param value 要存储的值
 * @param ttl 过期时间（毫秒），如果为 undefined 或 null 则永不过期
 * @returns 带 TTL 的存储值
 */
export function createStorageValueWithTTL<T>(value: T, ttl?: number): StorageValueWithTTL<T> {
  return {
    value,
    expires: ttl ? Date.now() + ttl : null
  };
}

// 预热速率限制（为特定键设置初始值）
export async function warmupRateLimit(
  store: RateLimitStore,
  key: string,
  windowMs: number,
  initialCount: number = 0
): Promise<void> {
  const now = Date.now();
  const record: RateLimitRecord = {
    count: initialCount,
    resetTime: now + windowMs,
    firstHit: now,
  };
  await store.set(key, record, windowMs);
}

/**
 * 清理存储中的过期记录
 * 注意：此函数需要先获取所有键，对于大型数据库可能效率较低
 * 
 * @param store CloudflareKVStore 实例
 * @param prefix 可选的键前缀过滤
 * @returns 清理的记录数量
 */
export async function cleanExpiredRecords(
  kv: KVNamespace,
  prefix: string = ''
): Promise<number> {
  let cleanedCount = 0;
  let cursor = '';
  
  try {
    do {
      // 使用 Cloudflare KV 的 list 方法获取键列表
      // 注意：这需要 Cloudflare KV 的 list 功能，确保你的账户支持
      const result = await kv.list({ prefix, cursor, limit: 1000 });
      cursor = result.cursor;
      
      const keys = result.keys;
      
      // 批量检查每个键
      for (const { name } of keys) {
        const value = await kv.get(name);
        if (!value) continue;
        
        try {
          const storedData = JSON.parse(value) as StorageValueWithTTL<any>;
          
          if (isExpired(storedData)) {
            await kv.delete(name);
            cleanedCount++;
          }
        } catch (e) {
          console.error(`Failed to parse data for key ${name}:`, e);
        }
      }
    } while (cursor !== '');
    
    return cleanedCount;
  } catch (error) {
    console.error('Error cleaning expired records:', error);
    return cleanedCount;
  }
}

// 全局类型声明
declare global {
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string | null, cursor?: string | null, limit?: number }): Promise<{
      keys: Array<{ name: string, expiration?: number, metadata?: any }>;
      list_complete: boolean;
      cursor: string;
    }>;
  }

  // 保留类型但我们不再使用 expirationTtl
  interface KVNamespacePutOptions {
    expiration?: number;
    metadata?: any;
  }
}
