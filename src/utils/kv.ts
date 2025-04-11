/**
 * KV缓存工具类
 * 提供简单的API来处理KV的读写和缓存控制
 */

// 全局存储KV命名空间
let globalKVNamespace: KVNamespace | undefined;

export class KVCache {
  /**
   * 初始化KV缓存工具类，存储全局KV命名空间
   * 应在应用启动时调用此方法
   * @param kvNamespace KV命名空间
   */
  static initialize(kvNamespace: KVNamespace | undefined): void {
    if (kvNamespace) {
      console.log('Initializing KV cache with global namespace');
      globalKVNamespace = kvNamespace;
    } else {
      console.warn('No KV namespace provided for KV cache initialization');
    }
  }

  /**
   * 使用缓存包装异步函数
   * 如果缓存存在且未过期，返回缓存数据
   * 否则执行函数获取新数据并缓存
   * 
   * @param key 缓存键
   * @param fn 获取数据的异步函数
   * @param options 配置选项
   * @returns 缓存数据或新获取的数据
   */
  static async wrap<T>(
    key: string,
    fn: () => Promise<T>,
    options: { 
      ttl?: number,  // 缓存有效期（秒）
      logHits?: boolean, // 是否记录缓存命中日志
      forceFresh?: boolean // 强制忽略缓存，获取新数据
    } = {}
  ): Promise<T> {
    // 设置默认选项
    const ttl = options.ttl || 3600; // 默认1小时
    const logHits = options.logHits !== false;
    const forceFresh = options.forceFresh || false;
    
    // 如果没有提供KV或强制刷新，直接执行函数
    if (!globalKVNamespace || forceFresh) {
      return await fn();
    }
    
    try {
      // 尝试从KV获取缓存数据
      const cached = await globalKVNamespace.get(key, 'json') as { 
        timestamp: number, 
        data: T 
      } | null;
      
      // 检查缓存是否存在且未过期
      if (cached && (Date.now() - cached.timestamp < ttl * 1000)) {
        if (logHits) {
          console.log(`KV cache hit for key: ${key}`);
        }
        return cached.data;
      }
      
      if (logHits) {
        console.log(`KV cache miss for key: ${key}, fetching fresh data`);
      }
      
      // 缓存不存在或已过期，执行函数获取新数据
      const data = await fn();
      
      // 存储新数据到KV缓存
      const cacheData = {
        timestamp: Date.now(),
        data
      };
      
      // 异步写入KV，不等待完成
      globalKVNamespace.put(key, JSON.stringify(cacheData), {
        expirationTtl: ttl
      }).catch(err => console.error(`Error writing to KV cache: ${err}`));
      
      return data;
    } catch (error) {
      console.error(`KV cache error for key ${key}:`, error);
      // 发生错误时，尝试直接执行函数
      return await fn();
    }
  }
  
  /**
   * 清除指定键的缓存
   */
  static async invalidate(key: string): Promise<boolean> {
    if (!globalKVNamespace) return false;
    
    try {
      await globalKVNamespace.delete(key);
      return true;
    } catch (error) {
      console.error(`Error invalidating cache for key ${key}:`, error);
      return false;
    }
  }
  
  /**
   * 获取缓存数据但不执行函数（如果缓存不存在则返回null）
   */
  static async get<T>(key: string): Promise<T | null> {
    if (!globalKVNamespace) return null;
    
    try {
      const cached = await globalKVNamespace.get(key, 'json') as { 
        timestamp: number, 
        data: T 
      } | null;
      
      return cached ? cached.data : null;
    } catch (error) {
      console.error(`Error getting cache for key ${key}:`, error);
      return null;
    }
  }
  
  /**
   * 直接设置缓存数据
   */
  static async set<T>(
    key: string,
    data: T,
    ttl = 3600
  ): Promise<boolean> {
    if (!globalKVNamespace) return false;
    
    try {
      const cacheData = {
        timestamp: Date.now(),
        data
      };
      
      await globalKVNamespace.put(key, JSON.stringify(cacheData), {
        expirationTtl: ttl
      });
      
      return true;
    } catch (error) {
      console.error(`Error setting cache for key ${key}:`, error);
      return false;
    }
  }
} 