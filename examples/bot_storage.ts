import { Contact, log, type Message, Room } from 'wechaty'
import { createClient, type RedisClientType } from 'redis'
import { REDIS_KEY_ROOM_LIST, REDIS_KEY_MSG_COUNT, REDIS_KEY_REMARK_LIST, REDIS_URL } from './conf.ts'

const MAX_SECONDS = 300

class SentMessage {

    private sentMessageCache: Map<string, Array<[ Message, Date ]>>

    constructor () {
        this.sentMessageCache = new Map<string, Array<[ Message, Date ]>>()
    }

    private removeExpiredMessages (messages: Array<[ Message, Date ]>, now: Date, maxAgeSeconds = MAX_SECONDS) {
        // @ts-ignore
        while (messages.length > 0 && (now.getTime() - messages[0][1].getTime() > maxAgeSeconds * 1000)) {
            messages.shift()
        }
    }

    addMessage (id: string, message: Message) {
        const now = new Date()
        let messages = this.sentMessageCache.get(id)
        if (messages) {
            messages.push([ message, now ])
            this.removeExpiredMessages(messages, now)
            log.info('addMessage', 'add done, after removing expired messages, to:%s, length:%s', id, messages.length)
        } else {
            messages = [ [ message, now ] ]
            this.sentMessageCache.set(id, messages)
            log.info('addMessage', 'first time to add, to:%s, length:%s', id, messages.length)
        }
    }

    popMostRecentMessage (id: string, maxAgeSeconds: number = MAX_SECONDS): Message | undefined {
        const messages = this.sentMessageCache.get(id)
        if (!messages || messages.length === 0) {
            return undefined
        }
        log.info('popMostRecentMessage', 'before removing expired messages, to:%s, length:%s', id, messages.length)
        const recentMessage = messages.pop()
        log.info('popMostRecentMessage', 'after removing expired messages, to:%s, length:%s', id, messages.length)
        this.removeExpiredMessages(messages, new Date(), maxAgeSeconds)
        log.info('popMostRecentMessage', 'after removing expired messages, to:%s, length:%s', id, messages.length)
        log.error('popMostRecentMessage', 'after removing expired messages, to:%s, length:%s', id, messages.length)
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

    public popMostRecentMessage (id: string, maxAgeSeconds: number = MAX_SECONDS): Message | undefined {
        return this.sentMessageCache.popMostRecentMessage(id, maxAgeSeconds)
    }

    public addSentMessage (id: string, message: Message) {
        this.sentMessageCache.addMessage(id, message)
    }

}

export { BotStorage }
