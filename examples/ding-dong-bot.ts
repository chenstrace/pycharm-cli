#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { createClient } from 'redis'
import { promises as fs } from 'fs'

import {
    Contact,
    Message,
    ScanStatus,
    WechatyBuilder,
    log,
} from 'wechaty'

import qrcodeTerminal from 'qrcode-terminal';

// 请填写你的配置信息
const REDIS_URL = 'redis://127.0.0.1:6379';
const MSG_FILE = '/Users/chenjili/all.txt';
let aliasList: string[] = [];
const contactCache = new Map<string, Contact>();
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function get_alias() {
    try {
        const result: string[] = await redisClient.sMembers('alias_list');
        return result;
    } catch (error) {
        console.error('Redis error:', error);
    } finally {
    }
    return []
}


function onScan(qrcode: string, status: ScanStatus) {
    if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
        const qrcodeImageUrl = [
            'https://wechaty.js.org/qrcode/',
            encodeURIComponent(qrcode),
        ].join('')
        log.error('scan', 'onScan: %s(%s) - %s', ScanStatus[status], status, qrcodeImageUrl)

        qrcodeTerminal.generate(qrcode, { small: true })
    } else {
        log.error('scan', 'onScan: %s(%s)', ScanStatus[status], status)
    }
}

function onLogin(user: Contact) {
    log.error('onIn', '%s in', user)
}

function onLogout(user: Contact) {
    log.error('onOut', '%s out', user)
}

function formatDate(date: Date): string {
    const year: string = date.getFullYear().toString();
    const month: string = (date.getMonth() + 1).toString().padStart(2, '0');
    const day: string = date.getDate().toString().padStart(2, '0');
    const hour: string = date.getHours().toString().padStart(2, '0');
    const minute: string = date.getMinutes().toString().padStart(2, '0');
    const second: string = date.getSeconds().toString().padStart(2, '0');

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}


async function onMessage(msg: Message) {
    const room = msg.room()
    if (room) {
        return;
    }
    const from = msg.talker() //from
    const to = msg.listener() //to
    if (!from || from.type() !== bot.Contact.Type.Individual) {
        return;
    }
    const msg_text = msg.text()
    if (!msg_text) {
        return;
    }
    const content: string = `${formatDate(new Date())} | f(${from.name()}), t(${to?.name()}): ${msg_text}\n`;

    try {
        await fs.appendFile(MSG_FILE, content, { flush: true });
    } catch (err) {
        log.error('FileWrite', 'Error writing incoming message to file', err);
    }
}

async function sendMessage(contact: Contact, message: string) {
    try {
        await contact.say(message);
        log.info('RedisQueue', `Message sent: ${message}`);
        const from = bot.currentUser.name();
        const to = contact.name()
        const content: string = `${formatDate(new Date())} | f(${from}), t(${to}): ${message}\n`;

        try {
            await fs.appendFile(MSG_FILE, content, { flush: true });
        } catch (err) {
            log.error('FileWrite', 'Error writing outting message to file', err);
        }
    } catch (err) {
        log.error('RedisQueue', 'Error sending message:', err);
    }
}

async function processMessageQueue() {
    aliasList = await get_alias();

    log.info("processMessageQueue", "Processing message queue...")
    for (const alias of aliasList) {
        let message;
        while ((message = await redisClient.lPop(alias))) {
            let contact = contactCache.get(alias);
            if (!contact) {
                contact = await bot.Contact.find({ alias });
                if (contact) {
                    contactCache.set(alias, contact);
                }
                else {
                    log.error("processMessageQueue", "Contact not found for alias:", alias)
                }
            }
            if (contact) {
                await sendMessage(contact, message);
            } else {
                log.error('RedisQueue', `Contact not found for alias: ${alias}`);
            }
        }
    }
}

async function setupPeriodicMessageSending() {
    setInterval(processMessageQueue, 3000);
}

await redisClient.connect();
aliasList = await get_alias();
console.error("alias list:", aliasList);
if (aliasList.length === 0) {
    console.error("No alias found in redis, exiting...");
    process.exit(1);
}


try {
    const content: string = formatDate(new Date())  + " program begin\n";
    await fs.appendFile(MSG_FILE, content, { flush: true });
} catch (err) {
    console.error("Error writing program begin to file", err);
    log.error('main', 'Error writing program begin to file', err);
}
const bot = WechatyBuilder.build({ name: 'ding-dong-bot' });


bot.on('scan', onScan)
    .on('login', onLogin)
    .on('logout', onLogout)
    .on('message', onMessage)
    .on('ready', async () => {
        log.info('onReady', 'Bot is ready, setting up periodic message sending.');
        await setupPeriodicMessageSending();
    })
    .on('error', console.error)
    .start()
    .then(() => log.info('StarterBot', 'Starter Bot Started.'))
    .catch(e => log.error('handleException', e));