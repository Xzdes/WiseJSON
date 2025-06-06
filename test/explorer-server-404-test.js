#!/usr/bin/env node

/**
 * test/explorer-server-404-test.js
 * Тестирование 404 ошибки на несуществующем API эндпоинте
 */

const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const BASE_URL = 'http://127.0.0.1:3000';
let serverProcess;

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({
                        statusCode: res.statusCode,
                        body: JSON.parse(data)
                    });
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        serverProcess = spawn('node', ['explorer/server.js'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        serverProcess.stdout.on('data', (data) => {
            const line = data.toString();
            if (line.includes('WiseJSON Data Explorer running')) {
                resolve();
            }
        });

        serverProcess.stderr.on('data', (data) => {
            console.error('Server error:', data.toString());
        });

        serverProcess.on('exit', (code) => {
            console.log(`Server exited with code ${code}`);
        });
    });
}

function stopServer() {
    if (serverProcess) {
        serverProcess.kill();
    }
}

async function main() {
    console.log('=== WiseJSON Explorer Server 404 Test Start ===');
    await startServer();

    try {
        // Запрашиваем несуществующий эндпоинт
        const response = await fetchJson(`${BASE_URL}/api/nonexistent`);

        assert.strictEqual(response.statusCode, 404, 'Expected status 404');
        assert(response.body.error, 'Expected error message in response');

        console.log('✅ 404 error handled correctly.');
        console.log('=== WiseJSON Explorer Server 404 Test End ===');
    } catch (err) {
        console.error('Test failed:', err.message);
        process.exit(1);
    } finally {
        stopServer();
    }
}

main();
