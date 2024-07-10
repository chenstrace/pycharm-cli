#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { promises as fs } from 'fs'
import { Contact, log, Message, Room, Wechaty, WechatyBuilder } from 'wechaty'

import {
    appendLogFile,
    appendTimestampToFileName,
    fileExists,
    handleOutGoingMessage, parseMsgIdFromRevokedMsgText,
} from './utils.ts'
import { onScan, onLogin, onLogout } from './events.ts'
import {
    MSG_FILE,
    ATT_SAVE_DIR,

} from './conf.ts'

import { BotStorage } from './bot_storage.ts'
import { format } from 'date-fns'
import os from 'os'
import path from 'path'

enum RemarkType {
    NORMAL = 1,
    OTHER = 2,
    GROUP = 3
}

async function getRoomInfoByMessage (msg: Message, storage: BotStorage): Promise<[ boolean, boolean ]> {
    const room = msg.room()
    let isRoomMsg = false
    let isAllowedRoomTopic = false
    if (room) {
        isRoomMsg = true
        const roomTopic: string = await room.topic()
        const allowedRoomTopics = await storage.getAllowedRoomTopics()
        isAllowedRoomTopic = allowedRoomTopics.includes(roomTopic)
    }

    return [ isRoomMsg, isAllowedRoomTopic ]
}

async function onMessage (msg: Message, bot: Wechaty, storage: BotStorage) {
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
        // 如果文件存在，则在文件名后面加上当前时间戳
        if (await fileExists(savePath)) {
            savePath = await appendTimestampToFileName(savePath)
        }
        await fileBox.toFile(savePath)
        message = savePath
    } else if (msgType === bot.Message.Type.Emoticon) {
        message = '[表情]'
    } else if (msgType === bot.Message.Type.Recalled) {
        message = '[撤回]'

        const recalledMessage = await msg.toRecalled()
        if (recalledMessage) {
            const orgMessageId = await parseMsgIdFromRevokedMsgText(recalledMessage.text())
            const orgMessage = storage.getMessageFromCache(orgMessageId)
            if (orgMessage) {
                message = `[撤回] ${orgMessage.fromName} -> ${orgMessage.toName}: ${orgMessage.msg}`
            }
        }
    } else {
        return
    }

    let fromText: string
    let toText: string
    const [ isRoomMsg, isAllowedRoomTopic ] = await getRoomInfoByMessage(msg, storage)

    if (isRoomMsg) {
        fromText = from.name()
        const room = msg.room()
        toText = room ? await room.topic() : '!members!'
    } else {
        fromText = storage.getRemarkById(from.id) || from.name() || await from.alias() || ''
        toText = storage.getRemarkById(to.id) || to.name() || await to.alias() || ''
    }
    let logContent
    if (msgType !== bot.Message.Type.Recalled) {
        storage.setMessageToCache(msg.id, {
            fromName: fromText,
            msg: message,
            toName: toText,
        })
        logContent = `from(${fromText}), to(${toText}): ${message}`
    } else {
        logContent = message
    }

    const isOnlyLogNamedFile = isRoomMsg && !isAllowedRoomTopic

    try {
        await appendLogFile(MSG_FILE, logContent, isOnlyLogNamedFile)
    } catch (err) {
        // @ts-ignore
        log.error('onMessage', 'Error writing incoming message to file: %s', err.message)
    }

    try {
        if (!isOnlyLogNamedFile) {
            await storage.incrMsgCount()
        }
    } catch (err) {
        // @ts-ignore
        log.error('onMessage', 'Error incr msg count:%s', err.message)
    }
}

async function processSpecialRemark (bot: Wechaty, storage: BotStorage, remarkType: RemarkType, message: string): Promise<[ Contact | Room | undefined, string, string ]> {
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

    let contact = storage.getContactByName(name)
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
                    storage.setId2Remark(contact.id, name)
                    storage.setName2Contact(name, contact)
                }
            } else if (contact instanceof bot.Room) {
                log.info('processSpecialRemark', 'bot.findGroup(%s) SUCCESS, result:%s', name, JSON.stringify(contact))
                const topic = await contact.topic()
                if (topic === name) {
                    storage.setId2Remark(contact.id, name)
                    storage.setName2Contact(name, contact)
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

async function processNormalRemark (bot: Wechaty, storage: BotStorage, remark: string) {
    let contact = storage.getContactByRemark(remark)

    if (contact) {
        log.info('processNormalRemark', 'Got (%s) from remark2ContactCache: (%s)', remark, JSON.stringify(contact))
        if (contact.id) {
            storage.setId2Remark(contact.id, remark)
        }
    } else {
        log.info('processNormalRemark', 'Doing bot.findByAlias(%s)', remark)
        contact = await bot.Contact.find({ alias: remark })
        if (contact) {
            log.info('processNormalRemark', 'bot.findByAlias(%s) SUCCESS, result:%s', remark, JSON.stringify(contact))

            if (contact.id) {
                storage.setId2Remark(contact.id, remark)
            }

            if (contact.friend()) {
                storage.setRemark2Contact(remark, contact)
                const contactName = contact.name()
                if (contactName) {
                    storage.setName2Contact(contactName, contact)
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

async function processMessageQueue (bot: Wechaty, storage: BotStorage) {
    log.info('processMessageQueue', 'Processing message queue...')

    const remarkList = await storage.getRemarks()
    for (const remark of remarkList) {
        let message: string | null = ''
        let contact
        let toText = ''
        let remarkType = RemarkType.NORMAL

        while ((message = await storage.lPopMsg(remark))) {
            if (remark === 'other') {
                remarkType = RemarkType.OTHER
            } else if (remark === 'group') {
                remarkType = RemarkType.GROUP
            }
            if (remarkType === RemarkType.NORMAL) {
                contact = await processNormalRemark(bot, storage, remark)
                toText = remark
            } else {
                [ contact, toText, message ] = await processSpecialRemark(bot, storage, remarkType, message)
            }

            if (contact && message) {
                await handleOutGoingMessage(storage, contact, toText, message, MSG_FILE)

            } else {
                if (!contact) {
                    log.error('processMessageQueue', 'sendRequest FAILED: empty contact,message(%s)', message)
                }
                if (!message) {
                    log.error('processMessageQueue', 'sendRequest FAILED: empty message,contact(%s)', JSON.stringify(contact))
                }
            }
        }
    }
}

function setupPeriodicMessageSending (bot: Wechaty, storage: BotStorage) {
    setInterval(() => {
        processMessageQueue(bot, storage).catch(error => {
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

async function onReady (bot: Wechaty, storage: BotStorage) {
    log.info('onReady', 'setting up timer')

    try {
        await appendLogFile(MSG_FILE, 'Program ready')
    } catch (err) {
        // @ts-ignore
        log.error('onReady', 'Error writing ready to file:%s', err.message)
    }

    storage.setId2Remark(bot.currentUser.id, 'me')
    setupPeriodicMessageSending(bot, storage)
    dumpContact(bot)
}

async function main () {
    const bot = WechatyBuilder.build({ name: 'ding-dong-bot' })
    const storage = new BotStorage()
    await storage.init()
    const remarkList = await storage.getRemarks()
    log.info('main', 'remark list: %s', remarkList.toString())
    if (remarkList.length === 0) {
        log.error('main', 'No contact found in redis')
    }

    try {
        await appendLogFile(MSG_FILE, 'Program begin')
    } catch (err) {
        // @ts-ignore
        log.error('main', 'Error writing Program begin to file exception:%s', err.message)
    }

    bot.on('scan', onScan)
    bot.on('login', onLogin)
    bot.on('logout', onLogout)
    bot.on('error', console.error)
    bot.on('message', msg => onMessage(msg, bot, storage))
    bot.on('ready', () => onReady(bot, storage))
    try {
        await bot.start()
        log.info('main', 'Started.')
    } catch (e) {
        // @ts-ignore
        log.error('main', 'bot.start() exception:%s', e.message)
    }
}

await main()
