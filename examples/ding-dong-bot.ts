#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'
import { createClient } from 'redis'
import { promises as fs } from 'fs'

import { Contact, log, Message, ScanStatus, WechatyBuilder } from 'wechaty'

import qrcodeTerminal from 'qrcode-terminal'
import { FileBox } from 'file-box'

import * as os from 'os'

const HOME_DIR = os.homedir();

const MSG_FILE = `${HOME_DIR}/all.txt`;
const ATT_SAVE_DIR = `${HOME_DIR}/attachments/`;
const REDIS_URL = 'redis://127.0.0.1:6379';
const REDIS_REMARK_KEY = "remark_list";
const allowedRoomTopics = ["几口人", "一家人"];

let remarkList: string[] = []; //没有备注时，名字就是备注
const remark2ContactCache = new Map<string, Contact>();
const id2RemarkCache = new Map<string, string>(); //id到备注的映射，作用是写入聊天记录的from to字段时，优先使用备注

const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function getRemarks() {
    try {
        const result: string[] = await redisClient.sMembers(REDIS_REMARK_KEY);
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
        log.info('scan', 'onScan: %s(%s) - %s', ScanStatus[status], status, qrcodeImageUrl)

        qrcodeTerminal.generate(qrcode, { small: true })
    } else {
        log.info('scan', 'onScan: %s(%s)', ScanStatus[status], status)
    }
}

function onLogin(user: Contact) {
    log.info('onIn', '%s in', user)
}

function onLogout(user: Contact) {
    log.info('onOut', '%s out', user)
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

async function is_message_should_be_handled(msg: Message): Promise<[boolean, boolean]> {
    const room = msg.room();
    if (room) {
        const room_topic: string = await room.topic();
        return [allowedRoomTopics.includes(room_topic), true];
    }

    return [true, false];
}

async function onMessage(msg: Message) {

    const [should_be_handled, is_room_msg] = await is_message_should_be_handled(msg);
    if (!should_be_handled) {
        return;
    }
    const from = msg.talker() //from
    const to = msg.listener() as Contact //to

    // console.log("onMessage from ", from);
    // console.log("onMessage to ", to);

    if (!from || from.type() !== bot.Contact.Type.Individual) {
        return;
    }
    const msg_type = msg.type()
    let message: string = "";
    if (msg_type === bot.Message.Type.Text) {
        message = msg.text()
    }
    else if (msg_type === bot.Message.Type.Image || msg_type == bot.Message.Type.Video || msg_type == bot.Message.Type.Audio) {
        const fileBox = await msg.toFileBox()
        const fileName = fileBox.name
        const save_path = ATT_SAVE_DIR + fileName;
        await fileBox.toFile(save_path)
        message = save_path
    }
    else {
        return;
    }
    if (!message) {
        return;
    }

    let from_text;
    let to_text;

    if (is_room_msg) {
        from_text = from.name()
        to_text = "!members!"
    }
    else {
        const from_id = from.id
        const to_id = to.id
        // console.log("onMessage from_id ", from_id);
        // console.log("onMessage to_id ", to_id);

        from_text = id2RemarkCache.get(from_id)
        to_text = id2RemarkCache.get(to_id)

        if (!from_text) {
            from_text = from.name()
        }
        if (!from_text) {
            from_text = await from.alias()
        }

        if (!to_text) {
            to_text = to.name()
        }
        if (!to_text) {
            to_text = await to.alias()
        }
    }

    const content: string = `${formatDate(new Date())} | f(${from_text}), t(${to_text}): ${message}\n`;

    try {
        await fs.appendFile(MSG_FILE, content, { flush: true });
    } catch (err) {
        log.error('FileWrite', 'Error writing incoming message to file', err);
    }

    try {
        await redisClient.incr("msg_count")
    } catch (err) {
        log.error('RedisWrite', 'Error incr msg count', err);
    }
}

async function sendMessage(contact: Contact, remark: string, message: string) {
    try {
        if (message.startsWith('paste ')) {
            const file_path = message.replace('paste ', '');
            const file_stat = await fs.stat(file_path);
            if (file_stat.isFile()) {
                const fileBox = FileBox.fromFile(file_path)
                await contact.say(fileBox);
            }
            else {
                console.error("not file");
                return false;
            }
        }
        else {
            await contact.say(message);
        }
    } catch (err) {
        log.error('RedisQueue', 'Error sending(%s): %s', remark, message);
        return false;
    }

    log.info('sendMessage', `Sent(${remark}): ${message}`);
    const from_text = "me"
    const content: string = `${formatDate(new Date())} | f(${from_text}), t(${remark}): ${message}\n`;

    try {
        await fs.appendFile(MSG_FILE, content, { flush: true });
    } catch (err) {
        log.error('FileWrite', 'Error writing outing message to file', err);
    }
    return true;
}

async function processRemark(remark: string) {
    let contact = remark2ContactCache.get(remark);

    if (contact) {
        // log.info("processRemark", "got (%s) from cache", remark);
        // console.log("processRemark from cache", remark, contact);
        if (contact.id) {
            // console.log("processRemark from cache,contact_id", contact_id);
            id2RemarkCache.set(contact.id, remark);
        }
    } else {
        log.info("processRemark", "Contact.find(%s)", remark);
        contact = await bot.Contact.find({ alias: remark });
        if (contact) {
            if (contact.id) {
                id2RemarkCache.set(contact.id, remark);
                // console.log("processRemark set contact id to cache:", contact.id, remark);
            }
            if (contact.friend()) {
                remark2ContactCache.set(remark, contact);
                // console.log("processRemark found contact:", contact);
            }
            else {
                log.info("processRemark", "found (%s), but NOT friend, SYNC", remark);
                await contact.sync();
            }
        }
        else {
            log.error("processRemark", "Contact.find(%s) FAIL", remark);

        }
    }
    // console.log("processRemark return ", contact);

    return contact;
}



async function processMessageQueue() {
    remarkList = await getRemarks();

    log.info("processMessageQueue", "Processing message queue...")
    for (const remark of remarkList) {
        let message;
        while ((message = await redisClient.lPop(remark))) {
            const contact = await processRemark(remark);
            if (contact) {
                await sendMessage(contact, remark, message);
            }
        }
    }
}

async function setupPeriodicMessageSending() {
    setInterval(processMessageQueue, 3000);
}

await redisClient.connect();
remarkList = await getRemarks();
console.error("remark list:", remarkList);
if (remarkList.length === 0) {
    console.error("No contact found in redis, exiting...");
    process.exit(1);
}

try {
    const content: string = formatDate(new Date()) + " program begin\n";
    await fs.appendFile(MSG_FILE, content, { flush: true });
} catch (err) {
    console.error("Error writing program begin to file", err);
}
const bot = WechatyBuilder.build({ name: 'ding-dong-bot' });


bot.on('scan', onScan)
    .on('login', onLogin)
    .on('logout', onLogout)
    .on('message', onMessage)
    .on('ready', async () => {
        log.info('onReady', 'setting up timer');

        try {
            const content: string = formatDate(new Date()) + " program ready\n";
            await fs.appendFile(MSG_FILE, content, { flush: true });
        } catch (err) {
            console.error("Error writing ready to file", err);
        }

        id2RemarkCache.set(bot.currentUser.id, 'me')
        // await initCache();
        await setupPeriodicMessageSending();
    })
    .on('error', console.error)
    .start()
    .then(() => log.info('main', 'Started.'))
    .catch(e => log.error('handleException', e));