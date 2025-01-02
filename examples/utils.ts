import { promises as fs } from 'fs'
import { join } from 'path'
import { format } from 'date-fns'
import { Contact, log, Room } from 'wechaty'
import { FileBox } from 'file-box'
import type { BotStorage } from './bot_storage.ts'
import { parseStringPromise } from 'xml2js'
import { HOME_DIR } from './conf.ts'

async function fileExists (filePath: string) {
    try {
        await fs.access(filePath)
        return true
    } catch (err) {
        return false
    }
}

async function mkdir (directoryPath: string): Promise<void> {
    try {
        await fs.mkdir(directoryPath, { recursive: true })
    } catch (error) {

    }
}

async function appendDateNamedLogFile (content: string, date: Date): Promise<void> {
    try {
        const directoryPath = join(HOME_DIR, 'wechaty', 'history')

        await mkdir(directoryPath)

        const formattedDate = format(date, 'yyyyMMddHH')
        const fileName = `${formattedDate}.txt`
        const filePath = join(directoryPath, fileName)

        await fs.appendFile(filePath, content, { flush: true })
    } catch (error) {
        console.error('Error writing message to file:', error)
    }
}

async function sendFileMessage (contact: Contact | Room, filePath: string) {
    try {
        const fileStat = await fs.stat(filePath)
        if (fileStat.isFile()) {
            const fileBox = FileBox.fromFile(filePath)
            return await contact.say(fileBox)
        } else {
            log.error('sendFileMessage', 'Not a file:', filePath)
        }
    } catch (err) {
        // @ts-ignore
        log.error('sendFileMessage', 'Error sending file(%s): %s', filePath, err.message)
    }
}

async function handleOutGoingMessage (storage: BotStorage, contact: Contact | Room, toText: string, message: string, logFilePath: string) {
    let res
    let searchContact = false
    try {
        if (message.startsWith('revoke') || message.startsWith('recall')) {
            const sentMsg = storage.popMostRecentMessage(contact.id)
            await sentMsg?.recall()
            return
        } else if (message.startsWith('paste ') || message.startsWith('sendfile ') || message.startsWith('sz ') || message.startsWith('contact ')) {
            const command = message.split(' ')[0]
            const arg = message.replace(`${command} `, '')

            if (message.startsWith('contact ')) {
                searchContact = true
                const searchResults = storage.searchContact(arg)
                message = JSON.stringify(searchResults, null, 2)
                toText = 'me'
            } else {
                res = await sendFileMessage(contact, arg)
            }

        } else {
            res = await contact.say(message)
        }
        if (!res) {
            if (!searchContact) {
                log.error('handleOutGoingMessage', 'contact.say return empty message')
            }
        } else {
            storage.addSentMessage(contact.id, res)
            storage.setMessageToCache(res.id, {
                fromName: 'me',
                msg: message,
                toName: toText,
            })
        }
    } catch (err) {
        // @ts-ignore
        log.error('handleOutGoingMessage', 'Error sending: %s, %s', message, err.message)
        return
    }

    log.info('handleOutGoingMessage', 'Sent(%s): %s', toText, message)
    const fromText = 'me'
    const logContent: string = `from(${fromText}), to(${toText}): ${message}`

    try {
        await appendLogFile(logFilePath, logContent)
        if (searchContact) {
            await storage.incrMsgCount()
        }
    } catch (err) {
        // @ts-ignore
        log.error('handleOutGoingMessage', 'Error writing outing message to file:%s', err.message)
    }
    return res
}

async function appendLogFile (filePath: string, content: string, isOnlyLogNamedFile = false) {
    const date = new Date()
    const logContent: string = `${format(date, 'yyyy-MM-dd HH:mm:ss')} | ${content}\n`
    await appendDateNamedLogFile(logContent, date)

    if (!isOnlyLogNamedFile) {
        await fs.appendFile(filePath, logContent, { flush: true })
    }
}

async function parseMsgIdFromRevokedMsgText (text: string) {
    try {
        const result = await parseXml(text)
        if (result) {
            return result.sysmsg.revokemsg[0].msgid[0]
        }
    } catch (err) {
        console.error(`Error parsing msg id failed: ${err}`)
    }
    return ''
}

async function parseContactFromNameCardMsg (text: string) {
    try {
        const result = await parseXml(text)
        if (result && result.msg) {
            const nickname = result.msg.$.nickname || ''
            const username = result.msg.$.username || ''
            return [ nickname, username ]
        }
    } catch (err) {
        console.error(`Error parsing msg id failed: ${err}`)
    }
    return [ '', '' ]
}

async function parseXml (xml: string) {
    try {
        return await parseStringPromise(xml)

    } catch (err) {
        console.error(`Error parsing XML: ${err}`)
    }
}

export {
    fileExists,
    appendLogFile,
    handleOutGoingMessage,
    parseMsgIdFromRevokedMsgText,
    parseContactFromNameCardMsg,
    mkdir,
}
