import { Contact, log, type Message, Room, type Wechaty } from 'wechaty'
import { createClient, type RedisClientType } from 'redis'
import { REDIS_KEY_ROOM_LIST, REDIS_KEY_MSG_COUNT, REDIS_KEY_REMARK_LIST, REDIS_URL } from './conf.ts'
import { LRUCache } from 'lru-cache'

interface SimpleMsg {
    fromName: string;
    toName: string
    msg: string;
}

enum ContactType {
    Group = 'GROUP',
    Individual = 'INDIVIDUAL',
}

class SimpleMessageCache {

    // key is msgId
    private cache: LRUCache<string, SimpleMsg>

    constructor (maxAgeSeconds: number) {
        const cacheOptions = {
            ttl: 1000 * maxAgeSeconds,
            ttlAutopurge: true,
        }
        this.cache = new LRUCache<string, SimpleMsg>(cacheOptions)
    }

    set (msgId: string, simpleMsg: SimpleMsg) {
        this.cache.set(msgId, simpleMsg)
    }

    get (msgId: string): SimpleMsg | undefined {
        return this.cache.get(msgId)
    }

}

class SentMessage {

    private cache: Map<string, Array<[ Message, Date ]>>
    private readonly maxAgeSeconds

    constructor (maxAgeSeconds: number) {
        this.cache = new Map<string, Array<[ Message, Date ]>>()
        this.maxAgeSeconds = maxAgeSeconds
    }

    private removeExpired (messages: Array<[ Message, Date ]>, now: Date) {
        const cutoffTime = now.getTime() - this.maxAgeSeconds * 1000

        let removeCount = 0
        for (let i = 0; i < messages.length; i++) {
            if ((messages[i] as [ Message, Date ])[1].getTime() > cutoffTime) {
                break
            }
            removeCount++
        }

        if (removeCount > 0) {
            messages.splice(0, removeCount)
        }
    }

    add (id: string, message: Message) {
        const now = new Date()
        let messages = this.cache.get(id)
        if (messages) {
            messages.push([ message, now ])
            this.removeExpired(messages, now)
        } else {
            messages = [ [ message, now ] ]
            this.cache.set(id, messages)
        }
    }

    popMostRecent (id: string): Message | undefined {
        const messages = this.cache.get(id)
        if (!messages || messages.length === 0) {
            return undefined
        }
        const recentMessage = messages.pop()
        this.removeExpired(messages, new Date())
        return recentMessage ? recentMessage[0] : undefined
    }

}

class ContactList {

    private contacts: { name: string, alias: string }[] = []

    /**
     * 添加联系人到联系人列表
     * @param name 联系人姓名
     * @param alias 联系人别名
     */
    public add (name: string, alias: string): void {
        this.contacts.push({
            alias,
            name,
        })
    }

    /**
     * 搜索联系人列表，根据key匹配name或alias的子串
     * @param key 搜索关键字
     * @returns 匹配到的联系人列表
     */
    public search (key: string): { name: string, alias: string }[] {
        return this.contacts.filter(contact => contact.name.includes(key) || contact.alias.includes(key),
        )
    }

}

class BotStorage {

    private remark2ContactCache = new Map<string, Contact>()
    private id2RemarkCache = new Map<string, string>()
    private name2ContactCache = new Map<string, Contact | Room>()
    private redisClient: RedisClientType
    private sentMessage = new SentMessage(300)
    private messageCache = new SimpleMessageCache(300)
    private contactList = new ContactList()
    private bot: Wechaty

    constructor (bot: Wechaty) {
        this.redisClient = createClient({ url: REDIS_URL })
        this.bot = bot
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

    private createKey (type: ContactType, key: string): string {
        return `${type}-${key}`
    }

    public getContactByNameAndType (name: string, type: ContactType): Contact | Room | undefined {
        const key = this.createKey(type, name)
        return this.name2ContactCache.get(key)
    }

    public setName2Contact (name: string, contact: Contact | Room) {
        if (contact instanceof this.bot.Contact) {
            this.name2ContactCache.set(this.createKey(ContactType.Individual, name), contact)
        } else if (contact instanceof this.bot.Room) {
            this.name2ContactCache.set(this.createKey(ContactType.Group, name), contact)
        }
    }

    public popMostRecentMessage (fromId: string): Message | undefined {
        return this.sentMessage.popMostRecent(fromId)
    }

    public addSentMessage (fromId: string, message: Message) {
        this.sentMessage.add(fromId, message)
    }

    public setMessageToCache (msgId: string, simpleMsg: SimpleMsg) {
        this.messageCache.set(msgId, simpleMsg)
    }

    public getMessageFromCache (msgId: string): SimpleMsg | undefined {
        return this.messageCache.get(msgId)
    }

    public async setLastOnlineTime (lastOnlineTime: number) {
        await this.redisClient.set('last_online_time', lastOnlineTime)
    }

    public addContact (name: string, alias: string) {
        this.contactList.add(name, alias)
    }

    public searchContact (key: string) {
        return this.contactList.search(key)
    }

}

export { BotStorage, ContactType }
