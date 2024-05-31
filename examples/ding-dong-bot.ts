#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { createClient } from 'redis'
import { promises as fs } from 'fs'
import { Contact, log, Message, ScanStatus, Wechaty, WechatyBuilder } from 'wechaty'
import qrcodeTerminal from 'qrcode-terminal'
import { FileBox } from 'file-box'

import * as os from 'os'

const HOME_DIR = os.homedir()
const MSG_FILE = `${HOME_DIR}/all.txt`
const ATT_SAVE_DIR = `${HOME_DIR}/attachments/`
const REDIS_URL = 'redis://127.0.0.1:6379'
const REDIS_REMARK_KEY = 'remark_list'
const allowedRoomTopics = [ '几口人', '一家人' ]

let remarkList: string[] = [] // 没有备注时，名字就是备注
const remark2ContactCache = new Map<string, Contact>()
const id2RemarkCache = new Map<string, string>() // id到备注的映射，作用是写入聊天记录的from to字段时，优先使用备注

async function getRemarks () {
    try {
        const result: string[] = await redisClient.sMembers(REDIS_REMARK_KEY)
        return result
    } catch (error) {
        console.error('Redis error:', error)
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
        log.info('scan', 'onScan: %s(%s) - %s', ScanStatus[status], status, qrcodeImageUrl)

        qrcodeTerminal.generate(qrcode, { small: true })
    } else {
        log.info('scan', 'onScan: %s(%s)', ScanStatus[status], status)
    }
}

function onLogin (user: Contact) {
    log.info('onIn', '%s in', user)
}

function onLogout (user: Contact) {
    log.info('onOut', '%s out', user)
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
    const from = msg.talker() // from
    const to = msg.listener() as Contact // to

    // console.log("onMessage from ", from);
    // console.log("onMessage to ", to);

    if (from.type() !== bot.Contact.Type.Individual) {
        return
    }
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

    const content: string = `${formatDate(new Date())} | f(${fromText}), t(${toText}): ${message}\n`

    try {
        await fs.appendFile(MSG_FILE, content, { flush: true })
    } catch (err) {
        log.error('FileWrite', 'Error writing incoming message to file', err)
    }

    try {
        await redisClient.incr('msg_count')
    } catch (err) {
        log.error('RedisWrite', 'Error incr msg count', err)
    }
}

async function sendMessage (contact: Contact, toContactText: string, message: string) {
    try {
        if (message.startsWith('paste ')) {
            const filePath = message.replace('paste ', '')
            const fileStat = await fs.stat(filePath)
            if (fileStat.isFile()) {
                const fileBox = FileBox.fromFile(filePath)
                await contact.say(fileBox)
            } else {
                console.error('not file')
                return false
            }
        } else {
            await contact.say(message)
        }
    } catch (err) {
        log.error('RedisQueue', 'Error sending(%s): %s', toContactText, message)
        return false
    }

    log.info('sendMessage', `Sent(${toContactText}): ${message}`)
    const fromText = 'me'
    const content: string = `${formatDate(new Date())} | f(${fromText}), t(${toContactText}): ${message}\n`

    try {
        await fs.appendFile(MSG_FILE, content, { flush: true })
    } catch (err) {
        log.error('FileWrite', 'Error writing outing message to file', err)
    }
    return true
}

async function processOtherRemark (message: string): Promise<[ Contact | undefined, string, string ]> {
    const nameStartIndex = message.indexOf('#')
    const nameEndIndex = message.indexOf('#', nameStartIndex + 1)

    if (nameStartIndex === -1) {
        log.error('processOtherRemark:', 'first # NOT found')
        return [ undefined, '', '' ]
    }
    if (nameEndIndex === -1) {
        log.error('processOtherRemark:', 'second # NOT found')
        return [ undefined, '', '' ]
    }
    const name = message.substring(nameStartIndex + 1, nameEndIndex)

    if (!name) {
        log.error('processOtherRemark:', 'parse name error')
        return [ undefined, '', '' ]
    }
    const msg = message.substring(nameEndIndex + 1).trim()

    if (!msg) {
        log.error('processOtherRemark:', 'parse msg error')
        return [ undefined, '', '' ]
    }
    console.error('processOtherRemark: parsed name:', name)
    console.error('processOtherRemark: parsed content:', msg)

    const contact = await bot.Contact.find({ name })
    console.error('processOtherRemark: contact result:', contact)
    if (contact && contact.friend()) {
        id2RemarkCache.set(contact.id, name)
    }
    return [ contact, name, msg ]
}

async function processSpecificRemark (remark: string) {

    let contact = remark2ContactCache.get(remark)

    if (contact) {
        // log.info("processSpecificRemark", "got (%s) from cache", remark);
        // console.log("processSpecificRemark from cache", remark, contact);
        if (contact.id) {
            // console.log("processSpecificRemark from cache,contact_id", contact_id);
            id2RemarkCache.set(contact.id, remark)
        }
    } else {
        log.info('processSpecificRemark', 'Contact.find(%s)', remark)
        contact = await bot.Contact.find({ alias: remark })
        if (contact) {
            if (contact.id) {
                id2RemarkCache.set(contact.id, remark)
                // console.log("processRemark set contact id to cache:", contact.id, remark);
            }
            if (contact.friend()) {
                remark2ContactCache.set(remark, contact)
                // console.log("processRemark found contact:", contact);
            } else {
                log.info('processSpecificRemark', 'found (%s), but NOT friend, SYNC', remark)
                await contact.sync()
            }
        } else {
            log.error('processSpecificRemark', 'Contact.find(%s) FAIL', remark)
        }
    }
    console.error('processSpecificRemark return ', contact)

    return contact
}

async function processMessageQueue () {
    remarkList = await getRemarks()

    log.info('processMessageQueue', 'Processing message queue...')
    for (const remark of remarkList) {
        let message: string | null = ''
        let contact: Contact | undefined
        let toContactText = ''
        while ((message = await redisClient.lPop(remark))) {
            if (remark === 'other') {
                [ contact, toContactText, message ] = await processOtherRemark(message)
            } else {
                contact = await processSpecificRemark(remark)
                toContactText = remark
            }

            if (contact && message) {
                await sendMessage(contact, toContactText, message)
            } else {
                console.error('processMessageQueue', 'sendMessage failed:', contact, message)
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
        console.error('Error writing ready to file', err)
    }

    id2RemarkCache.set(bot.currentUser.id, 'me')
    await setupPeriodicMessageSending()

}

async function main (bot: Wechaty) {
    remarkList = await getRemarks()
    console.error('remark list:', remarkList)
    if (remarkList.length === 0) {
        console.error('No contact found in redis, exiting...')
        process.exit(1)
    }

    try {
        const content: string = formatDate(new Date()) + ' Program begin\n'
        await fs.appendFile(MSG_FILE, content, { flush: true })
    } catch (err) {
        console.error('Error writing program begin to file', err)
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
        log.error('handleException', e)
    }
}

const redisClient = createClient({ url: REDIS_URL })
redisClient.on('error', (err) => console.error('Redis Client Error', err))
await redisClient.connect()

const bot = WechatyBuilder.build({ name: 'ding-dong-bot' })

await main(bot)
