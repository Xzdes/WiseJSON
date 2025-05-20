// wal-manager.js
const fs = require('fs/promises');
const path = require('path');
const { pathExists, ensureDirectoryExists, deleteFileIfExists, copyFileSafe } = require('./storage-utils.js');

const WAL_FILE_SUFFIX = '.wal.jsonl';
const WAL_PROCESSING_SUFFIX = '.processing_for_checkpoint';

/**
 * Возвращает путь к WAL-файлу для коллекции.
 * @param {string} collectionDirPath
 * @param {string} collectionName
 * @returns {string}
 */
function getWalPath(collectionDirPath, collectionName) {
    return path.join(collectionDirPath, `${collectionName}${WAL_FILE_SUFFIX}`);
}

/**
 * Проверяет/создаёт директорию для WAL.
 * @param {string} walPath
 * @param {string} collectionDirPath
 * @returns {Promise<void>}
 */
async function initializeWal(walPath, collectionDirPath) {
    const targetDir = collectionDirPath || path.dirname(walPath);
    await ensureDirectoryExists(targetDir);
}

/**
 * Записывает операцию в WAL.
 * По умолчанию использует fsync для надёжности.
 * @param {string} walPath
 * @param {object} operationEntry
 * @param {boolean} [forceSync=true]
 * @returns {Promise<void>}
 */
async function appendToWal(walPath, operationEntry, forceSync = true) {
    if (!operationEntry.ts) {
        const msg = `[WAL] ❌ Отсутствует временная метка (ts) в записи: ${JSON.stringify(operationEntry)}`;
        console.error(msg);
        throw new Error(msg);
    }

    const line = JSON.stringify(operationEntry) + '\n';
    let fileHandle;

    try {
        fileHandle = await fs.open(walPath, 'a');
        await fileHandle.appendFile(line, 'utf-8');
        if (forceSync) await fileHandle.sync();
    } catch (err) {
        console.error(`[WAL] Ошибка записи в "${walPath}": ${err.message}`);
        throw err;
    } finally {
        if (fileHandle) {
            try {
                await fileHandle.close();
            } catch (e) {
                console.warn(`[WAL] Ошибка при закрытии файла "${walPath}": ${e.message}`);
            }
        }
    }
}

/**
 * Читает и парсит WAL.
 * @param {string} walPath
 * @param {string} [sinceTs]
 * @returns {Promise<Array<object>>}
 */
async function readWal(walPath, sinceTs) {
    const entries = [];

    if (!(await pathExists(walPath))) return entries;

    let raw = '';
    try {
        raw = await fs.readFile(walPath, 'utf-8');
    } catch (err) {
        console.error(`[WAL] Ошибка чтения WAL "${walPath}": ${err.message}`);
        throw err;
    }

    const lines = raw.split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const entry = JSON.parse(line);
            if (!entry.op || !entry.ts) continue;
            if (sinceTs && entry.ts < sinceTs) continue;
            entries.push(entry);
        } catch (e) {
            console.warn(`[WAL] Пропущена некорректная строка: ${line.substring(0, 100)}...`);
        }
    }

    return entries;
}

/**
 * Переименовывает основной WAL в временный, чтобы освободить место для нового WAL.
 * @param {string} mainWalPath
 * @param {string} processingAttemptTs
 * @returns {Promise<string>} - путь к временному WAL
 */
async function prepareWalForCheckpoint(mainWalPath, processingAttemptTs) {
    const sanitizedTs = processingAttemptTs.replace(/[:.]/g, '-');
    const tempWalPath = `${mainWalPath}${WAL_PROCESSING_SUFFIX}_${sanitizedTs}`;

    if (await pathExists(mainWalPath)) {
        try {
            await fs.rename(mainWalPath, tempWalPath);
            console.log(`[WAL] WAL переименован: ${path.basename(mainWalPath)} → ${path.basename(tempWalPath)}`);
        } catch (err) {
            console.error(`[WAL] Ошибка переименования WAL: ${err.message}`);
            throw err;
        }
    } else {
        await fs.writeFile(tempWalPath, '', 'utf-8');
    }

    try {
        const handle = await fs.open(mainWalPath, 'a');
        await handle.close();
    } catch (err) {
        console.error(`[WAL] Ошибка создания нового WAL: ${err.message}`);
        throw err;
    }

    return tempWalPath;
}

/**
 * Объединяет свежие записи из старого WAL с текущим WAL после чекпоинта.
 * @param {string} mainWalPath
 * @param {string} walToProcessPath
 * @param {string} checkpointTs
 * @param {boolean} walForceSync
 * @returns {Promise<number>} - количество перенесённых записей
 */
async function finalizeWalAfterCheckpoint(mainWalPath, walToProcessPath, checkpointTs, walForceSync = true) {
    if (!(await pathExists(walToProcessPath))) return 0;

    let newEntries = [];

    try {
        const all = await readWal(walToProcessPath);
        newEntries = all.filter(entry => entry.ts > checkpointTs);
    } catch (err) {
        console.error(`[WAL] Ошибка при чтении WAL для финализации: ${err.message}`);
        throw err;
    }

    const currentWal = (await pathExists(mainWalPath)) ? await fs.readFile(mainWalPath, 'utf-8') : '';
    const currentLines = currentWal.trim() ? currentWal.trim().split('\n') : [];

    const finalLines = [...currentLines, ...newEntries.map(e => JSON.stringify(e))];
    const tmpFinalPath = `${mainWalPath}.${Date.now()}.tmp`;

    try {
        await fs.writeFile(tmpFinalPath, finalLines.join('\n') + '\n', 'utf-8');
        if (walForceSync) {
            const handle = await fs.open(tmpFinalPath, 'r+');
            await handle.sync();
            await handle.close();
        }
        await fs.rename(tmpFinalPath, mainWalPath);
    } catch (err) {
        console.error(`[WAL] Ошибка финализации WAL: ${err.message}`);
        throw err;
    }

    await deleteFileIfExists(walToProcessPath);
    return newEntries.length;
}

module.exports = {
    getWalPath,
    initializeWal,
    appendToWal,
    readWal,
    prepareWalForCheckpoint,
    finalizeWalAfterCheckpoint,
};
