
import { ApiKeyManager, getApiKeyManager } from "@/utils/apikey";
import { DurableObject } from "cloudflare:workers";


interface Env {
    OPENAI_API_KEY: string;
    MODEL_NAME?: string;
    DATABASE_URL?: string; // PostgreSQL connection string
    CHAT_CACHE?: KVNamespace; // KV namespace for caching
    APIUSAGE: DurableObjectNamespace<ApiUsage>
    POLAR_ACCESS_TOKEN: string;
    PROJECT_ID: string;
  } 
export class ApiUsage extends DurableObject<Env> {
    apiKeyManager: ApiKeyManager
    cost: number = 0
    lastVerifyTime: number = Date.now()
    remaining: number = 0
    isInitialized: boolean = false
    userId: string =''
    projectId: string = ''
    constructor(ctx: DurableObjectState, env: Env) {
      // Required, as we're extending the base class.
      super(ctx, env)
      this.apiKeyManager = getApiKeyManager(env)
    }

    async init ({userId, projectId}: {userId: string, projectId: string}) {
        if (this.isInitialized) {
            return
        }
        this.userId = userId
        this.projectId = projectId
        await this.ctx.blockConcurrencyWhile(async () => {
            // After initialization, future reads do not need to access storage.
            const [cost, lastVerifyTime, remaining ] = await Promise.all([
                this.ctx.storage.get<number>("cost"),
                this.ctx.storage.get<number>("lastVerifyTime"),
                this.ctx.storage.get<number>("remaining"),
            ])
            console.log('cost', cost, 'lastVerifyTime', lastVerifyTime, 'remaining', remaining)
            if (!cost || !lastVerifyTime || !remaining) {
               await this.syncFromRemote()
            } else {
                this.cost = cost
                this.lastVerifyTime = lastVerifyTime
                this.remaining = remaining
            }
        
            this.isInitialized = true
        });
    }


    async syncFromRemote() {
        try {
            const keyInfo = await this.apiKeyManager.getKeyState({
                userId: this.userId,
                projectId: this.projectId
            })
            this.cost = keyInfo.cost
            this.lastVerifyTime = keyInfo.lastVerifyTime
            this.remaining = keyInfo.remaining
            await Promise.all([
                this.ctx.storage.put("cost", this.cost),
                this.ctx.storage.put("lastVerifyTime", this.lastVerifyTime),
                this.ctx.storage.put("remaining", this.remaining),
            ])
        } catch (error) {
            console.error('syncFromRemote error', error)
        }
    }
    

    async consumeApiUsage({ cost }: { cost: number }) {
        const sumCost = this.cost + cost
        const needRemoteVerify = sumCost >= 100 || Date.now() - this.lastVerifyTime > 1000 * 60 * 5
        if (needRemoteVerify) {
            const keyInfo = await this.apiKeyManager.getKeyState({
                userId: this.userId,
                projectId: this.projectId
            })
            this.lastVerifyTime = keyInfo.lastVerifyTime
            if (keyInfo.remaining - sumCost < 0) {
                await this.ctx.storage.put("lastVerifyTime", this.lastVerifyTime)
                throw new Error('ApiUsage is not enough')
            }
            this.cost = 0
            this.remaining = keyInfo.remaining - sumCost
            await Promise.all([
                this.ctx.storage.put("cost", this.cost),
                this.ctx.storage.put("lastVerifyTime", this.lastVerifyTime),
                this.ctx.storage.put("remaining", this.remaining),
            ])
            await this.apiKeyManager.ingestEvent({
                userId: this.userId,
                cost: sumCost,
                projectId: this.projectId
            })
        } else {
            if (this.remaining - sumCost < 0) {
                throw new Error('ApiUsage is not enough')
            }
            this.cost = sumCost
            await Promise.all([
                this.ctx.storage.put("cost", this.cost),
            ])
        }
        this.cost = sumCost
        console.log('consumeApiUsage', this.cost, this.remaining, this.lastVerifyTime)
    }
  }