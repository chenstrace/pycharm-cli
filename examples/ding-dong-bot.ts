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
import { FileBox } from "file-box";


import * as os from 'os';
const HOME_DIR = os.homedir();

const MSG_FILE = `${HOME_DIR}/all.txt`;
const ATT_SAVE_DIR = `${HOME_DIR}/attachments/`;
const REDIS_URL = 'redis://127.0.0.1:6379';
const REDIS_REMARK_KEY = "remark_list";
const allowedRoomTopics = ["几口人", "一家人"];

let remarkList: string[] = []; //没有备注时，名字就是备注
const remark2ContactCache = new Map<string, Contact>();
const name2RemarkCache = new Map<string, string>(); //名字到备注的映射，作用是写入聊天记录的from to字段时，优先使用备注

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
    process.exit(2);
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
        to_text = "!mems!"
    }
    else {
        const from_name = from.name()
        const to_name = to.name()
        from_text = name2RemarkCache.get(from_name)
        to_text = name2RemarkCache.get(to_name)
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
            const image_file_path = message.replace('paste ', '');
            const image_file_stat = await fs.stat(image_file_path);
            if (image_file_stat.isFile()) {
                const fileBox = FileBox.fromFile(image_file_path)
                await contact.say(fileBox);
            }
            else {
                console.error("not file");
            }
        }
        else {
            await contact.say(message);
        }

        log.info('RedisQueue', `Message sent: ${message}`);
        const from_text = "me"
        const to_text = remark
        const content: string = `${formatDate(new Date())} | f(${from_text}), t(${to_text}): ${message}\n`;

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
    remarkList = await getRemarks();

    log.info("processMessageQueue", "Processing message queue...")
    for (const remark of remarkList) {
        let message;
        while ((message = await redisClient.lPop(remark))) {
            let contact = remark2ContactCache.get(remark);

            if (!contact) {
                log.info("processMessageQueue", "Contact.find(%s)", remark);

                contact = await bot.Contact.find({ name: remark });
                if (contact) {
                    log.info("processMessageQueue", "Contact.find(%s) OK", remark);
                    remark2ContactCache.set(remark, contact);
                }
                else {
                    log.error("processMessageQueue", "Contact not found for name: %s", remark)
                }
            }
            if (contact) {
                const contact_name = contact.name()
                if (contact_name) {
                    name2RemarkCache.set(contact_name, remark)
                }
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

        name2RemarkCache.set(bot.currentUser.name(), 'me')
        await setupPeriodicMessageSending();
    })
    .on('error', console.error)
    .start()
    .then(() => log.info('main', 'Started.'))
    .catch(e => log.error('handleException', e));