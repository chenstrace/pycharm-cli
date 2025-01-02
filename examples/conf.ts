import os from 'os'
import path from 'path'

const HOME_DIR = os.homedir()
const MSG_FILE = path.join(HOME_DIR, 'wechaty', 'record.txt')
const ATT_SAVE_DIR = path.join(HOME_DIR, 'wechaty', 'attachments')
const REDIS_URL = 'redis://127.0.0.1:6379'
const REDIS_KEY_REMARK_LIST = 'remark_list'
const REDIS_KEY_ROOM_LIST = 'room_list'
const REDIS_KEY_MSG_COUNT = 'msg_count'

export { HOME_DIR, MSG_FILE, ATT_SAVE_DIR, REDIS_URL, REDIS_KEY_REMARK_LIST, REDIS_KEY_ROOM_LIST, REDIS_KEY_MSG_COUNT }
