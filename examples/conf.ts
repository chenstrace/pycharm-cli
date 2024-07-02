import os from 'os'

const HOME_DIR = os.homedir()
const MSG_FILE = `${HOME_DIR}/all.txt`
const ATT_SAVE_DIR = `${HOME_DIR}/attachments/`
const REDIS_URL = 'redis://127.0.0.1:6379'
const REDIS_REMARK_KEY = 'remark_list'
const REDIS_ALLOWED_ROOM_TOPICS_KEY = 'room_list'

export { MSG_FILE, ATT_SAVE_DIR, REDIS_URL, REDIS_REMARK_KEY, REDIS_ALLOWED_ROOM_TOPICS_KEY }