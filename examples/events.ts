import { Contact, log, ScanStatus } from 'wechaty'
import qrcodeTerminal from 'qrcode-terminal'

export function onScan (qrcode: string, status: ScanStatus) {
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

export function onLogin (user: Contact) {
    log.info('onLogin', '%s(%s) in', user, user.id)
}

export function onLogout (user: Contact) {
    log.info('onLogout', '%s out', user)
}
