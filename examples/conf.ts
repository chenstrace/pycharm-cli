import os from 'os'

const HOME_DIR = os.homedir()
const MSG_FILE = `${HOME_DIR}/all.txt`
const ATT_SAVE_DIR = `${HOME_DIR}/attachments/`
const REDIS_URL = 'redis://127.0.0.1:6379'
const REDIS_KEY_REMARK_LIST = 'remark_list'
const REDIS_KEY_ROOM_LIST = 'room_list'
const REDIS_KEY_MSG_COUNT = 'msg_count'

export { MSG_FILE, ATT_SAVE_DIR, REDIS_URL, REDIS_KEY_REMARK_LIST, REDIS_KEY_ROOM_LIST, REDIS_KEY_MSG_COUNT }
