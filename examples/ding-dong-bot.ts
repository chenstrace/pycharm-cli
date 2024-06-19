#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { createClient } from 'redis'
import { promises as fs } from 'fs'
import { Contact, Room, log, Message, ScanStatus, Wechaty, WechatyBuilder } from 'wechaty'
import qrcodeTerminal from 'qrcode-terminal'
import { FileBox } from 'file-box'

import * as os from 'os'

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
const allowedRoomTopics = [ '几口人', '一家人', '2024年幼升小交流讨论群' ]

let remarkList: string[] = [] // 没有备注时，名字就是备注
const remark2ContactCache = new Map<string, Contact>()
const id2RemarkCache = new Map<string, string>() // id到备注的映射，作用是写入聊天记录的from to字段时，优先使用备注
const name2ContactCache = new Map<string, Contact | Room>()

async function getRemarks () {
    try {
        const result: string[] = await redisClient.sMembers(REDIS_REMARK_KEY)
        return result
    } catch (error) {
        // @ts-ignore
        log.error('getRemarks', 'Redis error:%s', error.message)
    } finally { /* empty */
    }
    return []
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
    const year: string = date.getFullYear().toString()
    const month: string = (date.getMonth() + 1).toString().padStart(2, '0')
    const day: string = date.getDate().toString().padStart(2, '0')
    const hour: string = date.getHours().toString().padStart(2, '0')
    const minute: string = date.getMinutes().toString().padStart(2, '0')
    const second: string = date.getSeconds().toString().padStart(2, '0')

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

async function isMessageShouldBeHandled (msg: Message): Promise<[ boolean, boolean ]> {
    const room = msg.room()
    if (room) {
        const roomTopic: string = await room.topic()
        return [ allowedRoomTopics.includes(roomTopic), true ]
    }

    return [ true, false ]
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
    } else if (msgType === bot.Message.Type.Image || msgType === bot.Message.Type.Video || msgType === bot.Message.Type.Audio) {
        const fileBox = await msg.toFileBox()
        const fileName = fileBox.name
        const savePath = ATT_SAVE_DIR + fileName
        await fileBox.toFile(savePath)
        message = savePath
    } else {
        return
    }
    if (!message) {
        return
    }

    let fromText: string
    let toText: string

    if (isRoomMsg) {
        fromText = from.name()
        toText = '!members!'
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
        log.error('processSpecialRemark', 'first # NOT found')
        return [ undefined, '', '' ]
    }
    if (nameEndIndex === -1) {
        log.error('processSpecialRemark', 'second # NOT found')
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
