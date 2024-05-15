#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import 'dotenv/config.js'

import {
    Contact,
    Message,
    ScanStatus,
    WechatyBuilder,
    log,
} from 'wechaty'

import qrcodeTerminal from 'qrcode-terminal'
import readline from 'readline';
import type { ContactInterface } from 'wechaty/impls';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Choose a number: ',
});

const aliasList = ['victor', 'moon', 'zyb', 'mm', 'bb'];
let currentAliasIndex: number | null = null;


let targetContact: ContactInterface | null | undefined = null;
const contactCache = new Map<string, ContactInterface>();


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

async function onMessage(msg: Message) {
    const room = msg.room()
    if (room) {
        return
    }
    const contact = msg.talker()
    if (!contact || contact.type() !== bot.Contact.Type.Individual) {
        return
    }
    log.error('M', 'n(%s),m(%s)', contact.name(), msg.text())
}

async function onReady() {
    log.error('onReady', 'Ready Now');

    aliasList.forEach((alias, index) => {
        console.error(`${index + 1}. ${alias}`);
    });


    rl.setPrompt('Choose a number: ');

    rl.prompt();
    rl.on('line', handleMessage).on('close', handleClose);
}

async function findContactByAlias(alias: string): Promise<ContactInterface | null> {
    const contact = await bot.Contact.find({ alias: alias });
    return contact || null; // Explicitly return null if contact is not found (undefined)
}

async function handleMessage(line: string) {
    try {

    }
    catch (ee) {

    }
    line = line.trim();

    if (line === 'exit') {
        rl.close();
        return;
    }

    if (currentAliasIndex === null) {
        const choice = parseInt(line);
        if (isNaN(choice) || choice < 1 || choice > aliasList.length) {
            log.error('OOM', 'Invalid choice. Please try again.');
            rl.setPrompt('Choose a number: ');
            rl.prompt();
            return;
        }

        currentAliasIndex = choice - 1;

        let alias = aliasList[currentAliasIndex] as string;

        if (contactCache.has(alias)) {
            targetContact = contactCache.get(alias);
        } else {
            targetContact = await findContactByAlias(alias);
            if (targetContact) {
                contactCache.set(alias, targetContact);
            } else {
                log.error('OOM', `Contact not found: ${aliasList[currentAliasIndex]}`);
                currentAliasIndex = null;
                rl.setPrompt('Choose a number: ');
                rl.prompt();
                return;
            }
        }

        rl.setPrompt(`In(${aliasList[currentAliasIndex]}):`)
        rl.prompt();
    } else {
        if (targetContact) {
            const success_msg = "Success to " + aliasList[currentAliasIndex] + ":" + line;
            targetContact.say(line)
                .then(() => log.error('OOM', success_msg))
                .catch(e => log.error('OOM', 'Failed to :', e));
        }

        currentAliasIndex = null;
        aliasList.forEach((alias, index) => {
            console.error(`${index + 1}. ${alias}`);
        });
        rl.setPrompt('Choose a number: ');
        rl.prompt();
    }
}

function handleClose() {
    log.error('handleClose', 'Exiting message input mode.');
}

const bot = WechatyBuilder.build({ name: 'ding-dong-bot' });

bot.on('scan', onScan)
    .on('login', onLogin)
    .on('logout', onLogout)
    .on('message', onMessage)
    .on('ready', onReady)
    .on('error', console.error)
    .start()
    .then(() => log.error('StarterBot', 'Starter Bot Started.'))
    .catch(e => log.error('handleException', e));