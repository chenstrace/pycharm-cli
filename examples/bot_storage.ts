import { Contact, log, type Message, Room } from 'wechaty'
import { createClient, type RedisClientType } from 'redis'
import { REDIS_KEY_ROOM_LIST, REDIS_KEY_MSG_COUNT, REDIS_KEY_REMARK_LIST, REDIS_URL } from './conf.ts'

class SentMessage {

    private sentMessageCache: Map<string, Array<[ Message, Date ]>>

    constructor () {
        this.sentMessageCache = new Map<string, Array<[ Message, Date ]>>()
    }

    addMessage (id: string, message: Message) {
        const timestamp = new Date()
        let messages = this.sentMessageCache.get(id)
        if (messages) {
            messages.push([ message, timestamp ])
        } else {
            messages = [ [ message, timestamp ] ]
            this.sentMessageCache.set(id, messages)
        }
    }

    getMessage (id: string, maxAgeSeconds: number = 10800): Message | undefined {
        const messages = this.sentMessageCache.get(id)
        if (!messages || messages.length === 0) {
            return undefined
        }

        const recentMessage = messages.pop()
        const now = new Date()
        // @ts-ignore
        while (messages.length > 0 && (now.getTime() - messages[0][1].getTime() > maxAgeSeconds * 1000)) {
            messages.shift()
        }
        return recentMessage ? recentMessage[0] : undefined
    }

}

class BotStorage {

    private remark2ContactCache = new Map<string, Contact>()
    private id2RemarkCache = new Map<string, string>()
    private name2ContactCache = new Map<string, Contact | Room>()
    private redisClient: RedisClientType
    private sentMessageCache = new SentMessage()

    constructor () {
        this.redisClient = createClient({ url: REDIS_URL })
    }

    public async init () {
        await this.redisClient.connect()
    }

    async getFromRedis (key: string) {
        try {
            const result: string[] = await this.redisClient.sMembers(key)
            return result
        } catch (error) {
            // @ts-ignore
            log.error('getFromRedis', 'Redis error:%s', error.message)
        } finally { /* empty */
        }
        return []
    }

    async getRemarks () {
        return this.getFromRedis(REDIS_KEY_REMARK_LIST)
    }

    async getAllowedRoomTopics () {
        return this.getFromRedis(REDIS_KEY_ROOM_LIST)
    }

    async incrMsgCount () {
        return this.redisClient.incr(REDIS_KEY_MSG_COUNT)
    }

    async lPopMsg (key: string) {
        return this.redisClient.lPop(key)
    }

    public getContactByRemark (remark: string): Contact | undefined {
        return this.remark2ContactCache.get(remark)
    }

    public setRemark2Contact (remark: string, contact: Contact) {
        this.remark2ContactCache.set(remark, contact)
    }

    public getRemarkById (id: string): string | undefined {
        return this.id2RemarkCache.get(id)
    }

    public setId2Remark (id: string, remark: string) {
        this.id2RemarkCache.set(id, remark)
    }

    public getContactByName (name: string): Contact | Room | undefined {
        return this.name2ContactCache.get(name)
    }

    public setName2Contact (name: string, contact: Contact | Room) {
        this.name2ContactCache.set(name, contact)
    }

    public getSentMessage (id: string, maxAgeSeconds: number = 180): Message | undefined {
        return this.sentMessageCache.getMessage(id, maxAgeSeconds)
    }

    public addSentMessage (id: string, message: Message) {
        this.sentMessageCache.addMessage(id, message)
    }

}

export { BotStorage }
