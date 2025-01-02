#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { promises as fs } from 'fs'
import { Contact, log, Message, Room, Wechaty, WechatyBuilder } from 'wechaty'

import {
    appendLogFile,
    mkdir,
    fileExists,
    handleOutGoingMessage,
    parseContactFromNameCardMsg,
    parseMsgIdFromRevokedMsgText,
} from './utils.ts'
import { onLogin, onLogout, onScan } from './events.ts'
import { ATT_SAVE_DIR, HOME_DIR, MSG_FILE } from './conf.ts'

import { BotStorage, ContactType } from './bot_storage.ts'
import { format } from 'date-fns'
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
    // console.error(msg)
    const from = msg.talker()
    const to = msg.listener() as Contact
    if (from.type() !== bot.Contact.Type.Individual) {
        return
    }
    const msgType = msg.type()
    if (msgType === bot.Message.Type.Unknown) {
        return
    }
    // log.info('onMessage', 'from:%s', JSON.stringify(from))
    // log.info('onMessage', 'to:%s', JSON.stringify(to))
    let message: string = ''
    if (msgType === bot.Message.Type.Text || msgType === bot.Message.Type.Url) {
        message = msg.text()
    } else if (msgType === bot.Message.Type.Image
      || msgType === bot.Message.Type.Video
      || msgType === bot.Message.Type.Audio
      || msgType === bot.Message.Type.Attachment
    ) {
        if (msgType === bot.Message.Type.Attachment && msg.text() === '该类型暂不支持，请在手机上查看') {
            message = '[聊天记录] 该类型暂不支持，请在手机上查看'
        } else {
            const fileBox = await msg.toFileBox()
            const fileName = fileBox.name

            const savePath = path.join(
                ATT_SAVE_DIR,
                `${format(new Date(), 'yyyyMMddHHmmss')}-${fileName}`,
            )

            if (!(await fileExists(savePath))) {
                await fileBox.toFile(savePath)
            }
            message = savePath
        }
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
    } else if (msgType === bot.Message.Type.MiniProgram) {
        const miniProgram = await msg.toMiniProgram()
        message = `[小程序] ${miniProgram.description()} ${miniProgram.title()}`
    } else if (msgType === bot.Message.Type.Contact) {
        const [ nickname, username ] = await parseContactFromNameCardMsg(msg.text())
        message = `[联系人] ${nickname} ${username}`
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
        fromText = storage.getRemarkById(from.id) || await from.alias() || from.name() || ''
        toText = storage.getRemarkById(to.id) || await to.alias() || to.name() || ''
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
    let contact
    if (remarkType === RemarkType.OTHER) {
        contact = storage.getContactByRemark(name) // only for contact, not group
        if (contact) {
            log.info('processSpecialRemark', 'bot.getContactByRemark(%s) SUCCESS, result:%s', name, JSON.stringify(contact))
        } else {
            contact = storage.getContactByNameAndType(name, ContactType.Individual)
            if (contact) {
                log.info('processSpecialRemark', 'bot.getContactByNameAndIndividual(%s) SUCCESS, result:%s', name, JSON.stringify(contact))
            }
        }
    } else {
        contact = storage.getContactByNameAndType(name, ContactType.Group)
        if (contact) {
            log.info('processSpecialRemark', 'bot.getContactByNameAndGroup(%s) SUCCESS, result:%s', name, JSON.stringify(contact))
        }

    }

    if (contact) {
        return [ contact, name, msg ]
    }

    if (remarkType === RemarkType.OTHER) {
        log.info('processSpecialRemark', 'Doing bot.findAll({ name: %s })', name)
        const contactList = await bot.Contact.findAll({ name })

        if (contactList.length === 1) {
            contact = contactList[0]
        } else if (contactList.length === 0) {
            log.info('processSpecialRemark', 'bot.findAll({ name: %s }) FAILED, try to find by alias', name)
            const contactListByAlias = await bot.Contact.findAll({ alias: name })

            if (contactListByAlias.length === 1) {
                contact = contactListByAlias[0]
            }
        }
    } else {
        // RemarkType.GROUP
        log.info('processSpecialRemark', 'Doing bot.findAll({ topic: %s })', name)
        const roomList = await bot.Room.findAll({ topic: name })

        if (roomList.length === 1) {
            contact = roomList[0]
        }
    }

    if (contact) {
        if (contact instanceof bot.Contact) {
            log.info('processSpecialRemark', 'bot.findAll({ name/alias: %s }) SUCCESS, result:%s', name, JSON.stringify(contact))
            if (contact.friend()) {
                storage.setId2Remark(contact.id, name)
                storage.setName2Contact(name, contact)
            }
        } else if (contact instanceof bot.Room) {
            log.info('processSpecialRemark', 'bot.findAll({ topic: %s }) SUCCESS, result:%s', name, JSON.stringify(contact))
            const topic = await contact.topic()
            if (topic === name) {
                storage.setId2Remark(contact.id, name)
                storage.setName2Contact(name, contact)
            }
        }
    } else {
        const logMessage = `bot.findAll({ ${remarkType === RemarkType.OTHER ? 'name/alias' : 'topic'}: ${name} }) FAILED`
        log.error(`process${remarkType === RemarkType.OTHER ? 'Other' : 'Group'}Remark`, logMessage)
    }

    return [ contact, name, msg ]
}

async function processNormalRemark (bot: Wechaty, storage: BotStorage, remark: string) {
    const contactByRemark = storage.getContactByRemark(remark)  // only for contact, not group

    if (contactByRemark) {
        log.info('processNormalRemark', 'Got (%s) from cache by remark: (%s)', remark, JSON.stringify(contactByRemark))
        return await processContactFromCache(contactByRemark, remark, storage)
    }

    const contactByName = storage.getContactByNameAndType(remark, ContactType.Individual)
    if (contactByName && contactByName instanceof bot.Contact) {
        log.info('processNormalRemark', 'Got (%s) from cache by name: (%s)', remark, JSON.stringify(contactByName))
        return await processContactFromCache(contactByName, remark, storage)
    }

    log.info('processNormalRemark', 'Doing bot.findByAlias(%s)', remark)
    const contactList = await bot.Contact.findAll({ alias: remark })

    if (contactList.length === 1) {
        log.info('processNormalRemark', 'bot.findByAlias(%s) Got (%s)', remark, JSON.stringify(contactList[0]))
        return processContactFromFind(contactList[0] as Contact, remark, storage)
    }

    if (contactList.length === 0) {
        log.info('processNormalRemark', 'bot.findByAlias(%s) FAILED', remark)
        return processFallbackByName(bot, remark, storage)
    }

    log.info('processNormalRemark', 'bot.findByAlias(%s) got %d results', remark, contactList.length)
    return undefined
}

async function processFallbackByName (bot: Wechaty, remark: string, storage: BotStorage) {
    const contactList = await bot.Contact.findAll({ name: remark })

    if (contactList.length === 1) {
        log.info('processNormalRemark', 'bot.findByName(%s) Got (%s)', remark, JSON.stringify(contactList[0]))
        return processContactFromFind(contactList[0] as Contact, remark, storage)
    }

    log.info('processNormalRemark', 'bot.findByName(%s) got %d results', remark, contactList.length)
    return undefined
}

async function processContactFromCache (contact: Contact, remark: string, storage: BotStorage) {
    if (contact.id) {
        storage.setId2Remark(contact.id, remark)
    }

    return contact
}

async function processContactFromFind (contact: Contact, remark: string, storage: BotStorage) {
    if (contact.id) {
        storage.setId2Remark(contact.id, remark)
    }

    if (contact.friend()) {
        updateStorage(contact, remark, storage)
    } else {
        log.info('processNormalRemark', 'Found contact but not friend, syncing')
        await contact.sync()
    }

    return contact
}

function updateStorage (contact: Contact, remark: string, storage: BotStorage) {
    storage.setRemark2Contact(remark, contact)

    const contactName = contact.name()
    if (contactName) {
        storage.setName2Contact(contactName, contact)
    }
}

async function processMessageQueue (bot: Wechaty, storage: BotStorage) {
    log.info('processMessageQueue', `Processing message queue... Bot status: ${bot.isLoggedIn ? 'Running' : 'Not Running'}`)
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

async function processContact (bot: Wechaty, storage: BotStorage) {
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
            storage.addContact(name, alias)
        }
    }
    const sortedEntries = contactEntries.sort((a, b) => {
        return a.alias.toLowerCase().localeCompare(b.alias.toLowerCase())
    })

    const currentTime = new Date()
    const formattedTime = format(currentTime, 'yyyyMMdd-HHmmss')
    const fileName = `${formattedTime}.json`

    const dirPath = path.join(HOME_DIR, 'wechaty', 'contact')

    try {
        await fs.mkdir(dirPath, { recursive: true })
        const filePath = path.join(dirPath, fileName)
        await fs.writeFile(filePath, JSON.stringify(sortedEntries, null, 2), 'utf8')
        log.info('processContact', `Contacts have been written to ${filePath}`)
    } catch (error) {
        log.error('processContact', 'Error writing to file: %s', error)
    }
}

function dumpContact (bot: Wechaty, storage: BotStorage) {
    setTimeout(() => {
        processContact(bot, storage).catch(error => {
            console.error('Error in processContact:', error)
        })
    }, 1)
}

function setupPeriodicLoginStateSyncing (bot: Wechaty, storage: BotStorage) {
    setInterval(() => {
        synchronizeLoginState(bot, storage).catch(error => {
            console.error('Error in setupPeriodicLoginStateSyncing:', error)
        })
    }, 1000)
}

async function synchronizeLoginState (bot: Wechaty, storage: BotStorage) {
    const isLogin = bot.isLoggedIn
    if (isLogin) {
        const lastOnlineTime = Math.floor(Date.now() / 1000)
        await storage.setLastOnlineTime(lastOnlineTime)
    }
}

async function onReady (bot: Wechaty, storage: BotStorage) {
    log.info('onReady', 'setting up timer')

    try {
        await appendLogFile(MSG_FILE, 'Program ready')
        // const room = await bot.Room.find({ topic: '小号' })
        //
        // if (room) {
        //     console.error(room)
        //     room.on('leave', (leaverList, kick) => {
        //         const nameList = leaverList.map(c => c.name()).join(',')
        //         console.error(`Room lost member ${nameList}`)
        //         console.error(kick)
        //     })
        // } else {
        //     console.error('Room not found')
        // }

    } catch (err) {
        // @ts-ignore
        log.error('onReady', 'Error writing ready to file:%s', err.message)
    }

    storage.setId2Remark(bot.currentUser.id, 'me')
    setupPeriodicMessageSending(bot, storage)
    setupPeriodicLoginStateSyncing(bot, storage)
    dumpContact(bot, storage)
}

async function main () {
    const bot = WechatyBuilder.build({ name: 'ding-dong-bot' })
    const storage = new BotStorage(bot)
    await storage.init()
    const remarkList = await storage.getRemarks()
    log.info('main', 'remark list: %s', remarkList.toString())
    if (remarkList.length === 0) {
        log.error('main', 'No contact found in redis')
    }

    await mkdir(ATT_SAVE_DIR)

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
    // bot.on('room-leave', async (room, leaverList, remover) => {
    //     const nameList = leaverList.map(c => c.name()).join(',')
    //     console.error(`Room ${await room.topic()} lost member ${nameList}, the remover is: ${remover}`)
    // })
    try {
        await bot.start()
        log.info('main', 'Started.')
    } catch (e) {
        // @ts-ignore
        log.error('main', 'bot.start() exception:%s', e.message)
    }
}

await main()
