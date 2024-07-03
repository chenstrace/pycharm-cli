#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { createClient, type RedisClientType } from 'redis'
import { promises as fs } from 'fs'
import { Contact, log, Message, Room, Wechaty, WechatyBuilder } from 'wechaty'

import {
    appendContentToFile,
    appendTimestampToFileName,
    fileExistsAsync,
    formatDate,
    sendMessage,
} from './utils.ts'
import { onScan, onLogin, onLogout } from './events.ts'
import { MSG_FILE, ATT_SAVE_DIR, REDIS_URL, REDIS_REMARK_KEY, REDIS_ALLOWED_ROOM_TOPICS_KEY } from './conf.ts'

import * as os from 'os'

import path from 'path'
import { format } from 'date-fns'

enum RemarkType {
    NORMAL = 1,
    OTHER = 2,
    GROUP = 3
}

const remark2ContactCache = new Map<string, Contact>()
const id2RemarkCache = new Map<string, string>() // id到备注的映射，作用是写入聊天记录的from to字段时，优先使用备注
const name2ContactCache = new Map<string, Contact | Room>()

async function getSetFromRedis (key: string) {
    try {
        const result: string[] = await redisClient.sMembers(key)
        return result
    } catch (error) {
        // @ts-ignore
        log.error('getSetFromRedis', 'Redis error:%s', error.message)
    } finally { /* empty */
    }
    return []
}

async function getRemarks () {
    return getSetFromRedis(REDIS_REMARK_KEY)
}

async function getAllowedRoomTopics () {
    return getSetFromRedis(REDIS_ALLOWED_ROOM_TOPICS_KEY)
}

async function isMessageShouldBeHandled (msg: Message): Promise<[ boolean, boolean ]> {
    const room = msg.room()
    if (room) {
        const roomTopic: string = await room.topic()
        const allowedRoomTopics = await getAllowedRoomTopics()
        return [ allowedRoomTopics.includes(roomTopic), true ]
    }

    return [ true, false ]
}

async function onMessage (msg: Message, bot: Wechaty) {
    const [ shouldBeHandled, isRoomMsg ] = await isMessageShouldBeHandled(msg)
    if (!shouldBeHandled) {
        return
    }
    const from = msg.talker()
    const to = msg.listener() as Contact

    if (from.type() !== bot.Contact.Type.Individual) {
        return
    }
    log.info('onMessage', 'from:%s', JSON.stringify(from))
    log.info('onMessage', 'to:%s', JSON.stringify(to))
    const msgType = msg.type()
    let message: string = ''
    if (msgType === bot.Message.Type.Text) {
        message = msg.text()
    } else if (msgType === bot.Message.Type.Image
      || msgType === bot.Message.Type.Video
      || msgType === bot.Message.Type.Audio
      || msgType === bot.Message.Type.Attachment
    ) {
        const fileBox = await msg.toFileBox()
        const fileName = fileBox.name
        let savePath = ATT_SAVE_DIR + fileName
        // 如何文件存在，则在文件名后面加上当前时间戳
        if (await fileExistsAsync(savePath)) {
            savePath = await appendTimestampToFileName(savePath)
        }
        await fileBox.toFile(savePath)
        message = savePath
    } else if (msgType === bot.Message.Type.Emoticon) {
        message = '[表情]'
    } else {
        return
    }

    let fromText: string
    let toText: string

    if (isRoomMsg) {
        fromText = from.name()
        const room = msg.room()
        toText = room ? await room.topic() : '!members!'
    } else {
        fromText = id2RemarkCache.get(from.id) || from.name() || await from.alias() || ''
        toText = id2RemarkCache.get(to.id) || to.name() || await to.alias() || ''
    }
    const date = new Date()
    const logContent: string = `${formatDate(date)} | f(${fromText}), t(${toText}): ${message}\n`

    try {
        await fs.appendFile(MSG_FILE, logContent, { flush: true })
        await appendContentToFile(logContent, date)
    } catch (err) {
        // @ts-ignore
        log.error('onMessage', 'Error writing incoming message to file: %s', err.message)
    }

    try {
        await redisClient.incr('msg_count')
    } catch (err) {
        // @ts-ignore
        log.error('onMessage', 'Error incr msg count:%s', err.message)
    }
}

async function processSpecialRemark (bot: Wechaty, remarkType: RemarkType, message: string): Promise<[ Contact | Room | undefined, string, string ]> {
    const nameStartIndex = message.indexOf('#')
    const nameEndIndex = message.indexOf('#', nameStartIndex + 1)

    if (remarkType !== RemarkType.OTHER && remarkType !== RemarkType.GROUP) {
        log.error('processSpecialRemark', 'remarkType error: %s', remarkType)
        return [ undefined, '', '' ]
    }

    if (nameStartIndex === -1) {
        log.error('processSpecialRemark', 'wrong format, first # NOT found, msg(%s)', message)
        return [ undefined, '', '' ]
    }
    if (nameEndIndex === -1) {
        log.error('processSpecialRemark', 'wrong format, second # NOT found, msg(%s)', message)
        return [ undefined, '', '' ]
    }
    const name = message.substring(nameStartIndex + 1, nameEndIndex)

    if (!name) {
        log.error('processSpecialRemark', 'parse name error')
        return [ undefined, '', '' ]
    }
    const msg = message.substring(nameEndIndex + 1).trim()

    if (!msg) {
        log.error('processSpecialRemark:', 'parse msg error')
        return [ undefined, '', '' ]
    }
    log.info('processSpecialRemark', 'parsed name: %s', name)
    log.info('processSpecialRemark', 'parsed msg: %s', msg)

    let contact = name2ContactCache.get(name)
    if (contact) {
        return [ contact, name, msg ]
    } else {
        if (remarkType === RemarkType.OTHER) {
            log.info('processSpecialRemark', 'Doing bot.findPersonByName(%s)', name)
            contact = await bot.Contact.find({ name })
            if (!contact) {
                log.error('processSpecialRemark', 'bot.findPersonByName(%s) FAILED, try to findByAlias', name)
                contact = await bot.Contact.find({ alias: name })
            }
        } else {
            // RemarkType.GROUP
            log.info('processSpecialRemark', 'Doing bot.findGroup(%s)', name)
            contact = await bot.Room.find({ topic: name })
        }
        if (contact) {
            if (contact instanceof bot.Contact) {
                log.info('processSpecialRemark', 'bot.findPerson(%s) SUCCESS, result:%s', name, JSON.stringify(contact))
                if (contact.friend()) {
                    id2RemarkCache.set(contact.id, name)
                    name2ContactCache.set(name, contact)
                }
            } else if (contact instanceof bot.Room) {
                log.info('processSpecialRemark', 'bot.findGroup(%s) SUCCESS, result:%s', name, JSON.stringify(contact))
                const topic = await contact.topic()
                if (topic === name) {
                    id2RemarkCache.set(contact.id, name)
                    name2ContactCache.set(name, contact)
                }
            }
        } else {
            if (remarkType === RemarkType.OTHER) {
                log.error('processOtherRemark', 'bot.findPerson(%s) FAILED', name)
            } else {
                // RemarkType.GROUP
                log.error('processGroupRemark', 'bot.findGroup(%s) FAILED', name)
            }
        }
        return [ contact, name, msg ]
    }
}

async function processNormalRemark (bot: Wechaty, remark: string) {
    let contact = remark2ContactCache.get(remark)

    if (contact) {
        log.info('processNormalRemark', 'Got (%s) from remark2ContactCache: (%s)', remark, JSON.stringify(contact))
        if (contact.id) {
            id2RemarkCache.set(contact.id, remark)
        }
    } else {
        log.info('processNormalRemark', 'Doing bot.findByAlias(%s)', remark)
        contact = await bot.Contact.find({ alias: remark })
        if (contact) {
            log.info('processNormalRemark', 'bot.findByAlias(%s) SUCCESS, result:%s', remark, JSON.stringify(contact))

            if (contact.id) {
                id2RemarkCache.set(contact.id, remark)
            }

            if (contact.friend()) {
                remark2ContactCache.set(remark, contact)
                const contactName = contact.name()
                if (contactName) {
                    name2ContactCache.set(contactName, contact)
                }
            } else {
                log.info('processNormalRemark', 'bot.findByAlias(%s) found, but NOT friend, SYNC', remark)
                await contact.sync()
            }
        } else {
            log.error('processNormalRemark', 'bot.findByAlias(%s) FAIL', remark)
        }
    }
    return contact
}

async function processMessageQueue (bot: Wechaty) {
    const remarkList = await getRemarks()

    log.info('processMessageQueue', 'Processing message queue...')
    for (const remark of remarkList) {
        let message: string | null = ''
        let contact
        let toText = ''
        let remarkType = RemarkType.NORMAL

        while ((message = await redisClient.lPop(remark))) {
            if (remark === 'other') {
                remarkType = RemarkType.OTHER
            } else if (remark === 'group') {
                remarkType = RemarkType.GROUP
            }
            if (remarkType === RemarkType.NORMAL) {
                contact = await processNormalRemark(bot, remark)
                toText = remark
            } else {
                [ contact, toText, message ] = await processSpecialRemark(bot, remarkType, message)
            }

            if (contact && message) {
                await sendMessage(contact, toText, message, MSG_FILE)
            } else {
                if (!contact) {
                    log.error('processMessageQueue', 'sendMessage FAILED: empty contact,message(%s)', message)
                }
                if (!message) {
                    log.error('processMessageQueue', 'sendMessage FAILED: empty message,contact(%s)', JSON.stringify(contact))
                }
            }
        }
    }
}

function setupPeriodicMessageSending (bot: Wechaty) {
    setInterval(() => {
        processMessageQueue(bot).catch(error => {
            console.error('Error in processMessageQueue:', error)
        })
    }, 3000)
}

async function processContact (bot: Wechaty) {
    const contactList = await bot.Contact.findAll()

    interface ContactEntry {
        alias: string
        name: string
    }

    const contactEntries: ContactEntry[] = []

    for (let i = 0; i < contactList.length; i++) {
        const contact = contactList[i]
        if (contact && contact.type() === bot.Contact.Type.Individual && contact.friend()) {
            const alias = await contact.alias() || ''
            const name = contact.name()
            const entry: ContactEntry = {
                alias,
                name,
            }
            contactEntries.push(entry)
        }
    }
    const sortedEntries = contactEntries.sort((a, b) => {
        return a.alias.toLowerCase().localeCompare(b.alias.toLowerCase())
    })

    const currentTime = new Date()
    const formattedTime = format(currentTime, 'yyyyMMdd-HHmmss')
    const fileName = `${formattedTime}.json`

    const homeDir = os.homedir()
    const dirPath = path.join(homeDir, 'wechaty_contacts')

    try {
        await fs.mkdir(dirPath, { recursive: true })
        const filePath = path.join(dirPath, fileName)
        await fs.writeFile(filePath, JSON.stringify(sortedEntries, null, 2), 'utf8')
        log.info('processContact', `Contacts have been written to ${filePath}`)
    } catch (error) {
        log.error('processContact', 'Error writing to file: %s', error)
    }
}

function dumpContact (bot: Wechaty) {
    setTimeout(() => {
        processContact(bot).catch(error => {
            console.error('Error in processContact:', error)
        })
    }, 1)
}

async function onReady (bot: Wechaty) {
    log.info('onReady', 'setting up timer')

    try {
        const date = new Date()
        const content: string = formatDate(date) + ' Program ready\n'
        await fs.appendFile(MSG_FILE, content, { flush: true })
        await appendContentToFile(content, date)
    } catch (err) {
        // @ts-ignore
        log.error('onReady', 'Error writing ready to file:%s', err.message)
    }

    id2RemarkCache.set(bot.currentUser.id, 'me')
    setupPeriodicMessageSending(bot)
    dumpContact(bot)
}

async function main () {
    const bot = WechatyBuilder.build({ name: 'ding-dong-bot' })

    const remarkList = await getRemarks()
    log.info('main', 'remark list: %s', remarkList.toString())
    if (remarkList.length === 0) {
        log.error('main', 'No contact found in redis')
    }

    try {
        const date = new Date()
        const content: string = formatDate(date) + ' Program begin\n'
        await fs.appendFile(MSG_FILE, content, { flush: true })
        await appendContentToFile(content, date)
    } catch (err) {
        // @ts-ignore
        log.error('main', 'Error writing Program begin to file exception:%s', err.message)
    }

    bot.on('scan', onScan)
    bot.on('login', onLogin)
    bot.on('logout', onLogout)
    bot.on('error', console.error)
    bot.on('message', msg => onMessage(msg, bot))
    bot.on('ready', () => onReady(bot))
    try {
        await bot.start()
        log.info('main', 'Started.')
    } catch (e) {
        // @ts-ignore
        log.error('main', 'bot.start() exception:%s', e.message)
    }
}

const redisClient: RedisClientType = createClient({ url: REDIS_URL })
redisClient.on('error', (err) => console.error('Redis Client Error', err))
await redisClient.connect()

await main()
