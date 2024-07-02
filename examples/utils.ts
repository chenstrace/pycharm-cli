import { promises as fs } from 'fs'

export async function fileExistsAsync (filePath: string) {
    try {
        await fs.access(filePath)
        return true
    } catch (err) {
        return false
    }
}