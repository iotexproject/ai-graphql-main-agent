
import { ApiKeyManager, getApiKeyManager } from "@/utils/apikey";
import { DB } from "@/utils/db";
import { DurableObject } from "cloudflare:workers";


interface Env {
    OPENAI_API_KEY: string;
    MODEL_NAME?: string;
    DATABASE_URL?: string; // PostgreSQL connection string
    CHAT_CACHE?: KVNamespace; // KV namespace for caching
    POLAR_ACCESS_TOKEN: string;
    PROJECT_ID: string;
  } 
export class UserSession extends DurableObject<Env> {
    userId: string =''
    apiKey: string =''
    isInitialized: boolean = false
    lastSyncTime: number = 0
    constructor(ctx: DurableObjectState, env: Env) {
      // Required, as we're extending the base class.
      super(ctx, env)
    }

    async init ({apiKey}: {apiKey: string}) {
        if (this.isInitialized) {
            return {userId: this.userId}
        }
        this.apiKey = apiKey
        await this.ctx.blockConcurrencyWhile(async () => {
            // After initialization, future reads do not need to access storage.
            const [userId ] = await Promise.all([
                this.ctx.storage.get<string>("userId"),
            ])
            if (!userId || Date.now() - this.lastSyncTime > 1000 * 60 * 60) {
               await this.syncFromRemote()
            } else {
                this.userId = userId
            }
        
            this.isInitialized = true
        });
        return {userId: this.userId}
    }


    async syncFromRemote() {
        try {
            const userIdResult = await DB.query("SELECT user_id FROM apikey_rapid WHERE key = $1", [this.apiKey])
            const userId = userIdResult?.rows[0]?.user_id
            this.userId = userId
            this.lastSyncTime = Date.now()
            await Promise.all([
                this.ctx.storage.put("userId", userId),
                this.ctx.storage.put("lastSyncTime", this.lastSyncTime)
            ])
        } catch (error) { 
            console.error('syncFromRemote error', error)
        }
    }
  }