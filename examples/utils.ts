import { promises as fs } from 'fs'
import path, { join } from 'path'
import { format } from 'date-fns'
import { homedir } from 'os'
import { Contact, log, Room } from 'wechaty'
import { FileBox } from 'file-box'

async function fileExists (filePath: string) {
    try {
        await fs.access(filePath)
        return true
    } catch (err) {
        return false
    }
}

async function ensureDirectoryExists (directoryPath: string): Promise<void> {
    try {
        await fs.mkdir(directoryPath, { recursive: true })
    } catch (error) {

    }
}

async function appendContentToFile (content: string, date: Date): Promise<void> {
    try {
        const homeDir = homedir()
        const directoryPath = join(homeDir, 'wechaty_history')

        await ensureDirectoryExists(directoryPath)

        const formattedDate = format(date, 'yyyyMMddHH')
        const fileName = `${formattedDate}.txt`
        const filePath = join(directoryPath, fileName)

        await fs.appendFile(filePath, content, { flush: true })
    } catch (error) {
        console.error('Error writing message to file:', error)
    }
}

async function appendTimestampToFileName (filePath: string) {
    const parsedPath = path.parse(filePath)
    const timestamp = Date.now()
    const newFileName = `${parsedPath.name}_${timestamp}${parsedPath.ext}`
    return path.join(parsedPath.dir, newFileName)
}

function formatDate (date: Date): string {
    return format(date, 'yyyy-MM-dd HH:mm:ss')
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

async function sendMessage (contact: Contact | Room, toText: string, message: string, logFilePath: string) {
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
    const date = new Date()
    const logContent: string = `${formatDate(date)} | f(${fromText}), t(${toText}): ${message}\n`

    try {
        await fs.appendFile(logFilePath, logContent, { flush: true })
        await appendContentToFile(logContent, date)

    } catch (err) {
        // @ts-ignore
        log.error('sendMessage', 'Error writing outing message to file:%s', err.message)
    }
    return true
}

export { fileExists, appendContentToFile, appendTimestampToFileName, formatDate, sendMessage }
