#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { createClient } from 'redis'
import { promises as fs } from 'fs'
import { Contact, log, Message, Room, ScanStatus, Wechaty, WechatyBuilder } from 'wechaty'
import qrcodeTerminal from 'qrcode-terminal'
import { FileBox } from 'file-box'

// eslint-disable-next-line import/extensions
import { fileExistsAsync } from './utils'

import * as os from 'os'

import path from 'path'
import { format } from 'date-fns'

enum RemarkType {
    NORMAL = 1,
    OTHER = 2,
    GROUP = 3
}

const HOME_DIR = os.homedir()
const MSG_FILE = `${HOME_DIR}/all.txt`
const ATT_SAVE_DIR = `${HOME_DIR}/attachments/`
const REDIS_URL = 'redis://127.0.0.1:6379'
const REDIS_REMARK_KEY = 'remark_list'
const REDIS_ALLOWED_ROOM_TOPICS_KEY = 'room_list'
let allowedRoomTopics: string[] = []

let remarkList: string[] = []
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

function onScan (qrcode: string, status: ScanStatus) {
    if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
        const qrcodeImageUrl = [
            'https://wechaty.js.org/qrcode/',
            encodeURIComponent(qrcode),
        ].join('')
        log.info('onScan', 'ScanStatus: %s(%s) - %s', ScanStatus[status], status, qrcodeImageUrl)

        qrcodeTerminal.generate(qrcode, { small: true })
    } else {
        log.info('onScan', 'ScanStatus: %s(%s)', ScanStatus[status], status)
    }
}

function onLogin (user: Contact) {
    log.info('onLogin', '%s in', user)
}

function onLogout (user: Contact) {
    log.info('onLogout', '%s out', user)
}

function formatDate (date: Date): string {
    return format(date, 'yyyy-MM-dd HH:mm:ss')
}

async function isMessageShouldBeHandled (msg: Message): Promise<[ boolean, boolean ]> {
    const room = msg.room()
    if (room) {
        const roomTopic: string = await room.topic()
        allowedRoomTopics = await getAllowedRoomTopics()
        return [ allowedRoomTopics.includes(roomTopic), true ]
    }

    return [ true, false ]
}

async function appendTimestampToFileName (filePath: string) {
    const parsedPath = path.parse(filePath)
    const timestamp = Date.now()
    const newFileName = `${parsedPath.name}_${timestamp}${parsedPath.ext}`
    return path.join(parsedPath.dir, newFileName)
}

async function onMessage (msg: Message) {
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

    const logContent: string = `${formatDate(new Date())} | f(${fromText}), t(${toText}): ${message}\n`

    try {
        await fs.appendFile(MSG_FILE, logContent, { flush: true })
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

async function sendFileMessage (contact: Contact | Room, filePath: string) {
    try {
        const fileStat = await fs.stat(filePath)
        if (fileStat.isFile()) {
            const fileBox = FileBox.fromFile(filePath)
            await contact.say(fileBox)
        } else {
            log.error('sendFileMessage', 'Not a file:', filePath)
            return false
        }
    } catch (err) {
        // @ts-ignore
        log.error('sendFileMessage', 'Error sending file(%s): %s', filePath, err.message)
        return false
    }
    return true
}

async function sendMessage (contact: Contact | Room, toText: string, message: string) {
    try {
        if (message.startsWith('paste ') || message.startsWith('sendfile ')) {
            const command = message.split(' ')[0]
            const filePath = message.replace(`${command} `, '')
            if (!await sendFileMessage(contact, filePath)) {
                return false
            }
        } else {
            await contact.say(message)
        }
    } catch (err) {
        // @ts-ignore
        log.error('sendMessage', 'Error sending: %s, %s', message, err.message)
        return false
    }

    log.info('sendMessage', 'Sent(%s): %s', toText, message)
    const fromText = 'me'
    const logContent: string = `${formatDate(new Date())} | f(${fromText}), t(${toText}): ${message}\n`

    try {
        await fs.appendFile(MSG_FILE, logContent, { flush: true })
    } catch (err) {
        // @ts-ignore
        log.error('sendMessage', 'Error writing outing message to file:%s', err.message)
    }
    return true
}

async function processSpecialRemark (remarkType: RemarkType, message: string): Promise<[ Contact | Room | undefined, string, string ]> {
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

async function processNormalRemark (remark: string) {
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

async function processMessageQueue () {
    remarkList = await getRemarks()

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
                contact = await processNormalRemark(remark)
                toText = remark
            } else {
                [ contact, toText, message ] = await processSpecialRemark(remarkType, message)
            }

            if (contact && message) {
                await sendMessage(contact, toText, message)
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

async function setupPeriodicMessageSending () {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setInterval(processMessageQueue, 3000)
}

interface ContactEntry {
    alias: string
    name: string
}

async function processContact () {
    const contactList = await bot.Contact.findAll()

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

async function dumpContact () {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setTimeout(processContact, 1)
}

async function onReady () {
    log.info('onReady', 'setting up timer')

    try {
        const content: string = formatDate(new Date()) + ' Program ready\n'
        await fs.appendFile(MSG_FILE, content, { flush: true })
    } catch (err) {
        // @ts-ignore
        log.error('onReady', 'Error writing ready to file:%s', err.message)
    }

    id2RemarkCache.set(bot.currentUser.id, 'me')
    await setupPeriodicMessageSending()
    await dumpContact()

}

async function main (bot: Wechaty) {
    remarkList = await getRemarks()
    log.info('main', 'remark list: %s', remarkList.toString())
    if (remarkList.length === 0) {
        log.error('main', 'No contact found in redis')
    }

    try {
        const content: string = formatDate(new Date()) + ' Program begin\n'
        await fs.appendFile(MSG_FILE, content, { flush: true })
    } catch (err) {
        // @ts-ignore
        log.error('main', 'Error writing Program begin to file exception:%s', err.message)
    }

    bot.on('scan', onScan)
    bot.on('login', onLogin)
    bot.on('logout', onLogout)
    bot.on('error', console.error)
    bot.on('message', onMessage)
    bot.on('ready', onReady)
    try {
        await bot.start()
        log.info('main', 'Started.')
    } catch (e) {
        // @ts-ignore
        log.error('main', 'bot.start() exception:%s', e.message)
    }
}

const redisClient = createClient({ url: REDIS_URL })
redisClient.on('error', (err) => console.error('Redis Client Error', err))
await redisClient.connect()

const bot = WechatyBuilder.build({ name: 'ding-dong-bot' })

await main(bot)
