#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

async function runTest(filePath) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [filePath], {
            stdio: 'inherit'
        });

        child.on('close', (code) => {
            resolve({ file: path.basename(filePath), code });
        });
    });
}

async function main() {
    const testDir = path.resolve(__dirname);
    const files = await fs.readdir(testDir);

    // Ищем все js-файлы кроме run-all-tests.js, runAllTests.js, index.js, helpers.js и т.п.
    const exclude = ['run-all-tests.js', 'runAllTests.js', 'index.js', 'helpers.js'];
    const testFiles = files
        .filter(f =>
            f.endsWith('.js') &&
            !exclude.includes(f) &&
            !f.startsWith('_')
        )
        .map(f => path.join(testDir, f));

    if (testFiles.length === 0) {
        console.log('No test files found.');
        process.exit(0);
    }

    let passed = 0, failed = 0;
    for (const file of testFiles) {
        console.log(`\n===== Running: ${path.basename(file)} =====`);
        const result = await runTest(file);
        if (result.code === 0) {
            console.log(`✅ PASSED: ${result.file}`);
            passed++;
        } else {
            console.log(`❌ FAILED: ${result.file} (exit code ${result.code})`);
            failed++;
        }
    }

    console.log('\n============================');
    console.log(`Total: ${testFiles.length}, Passed: ${passed}, Failed: ${failed}`);
    if (failed > 0) {
        process.exit(1);
    } else {
        console.log('ALL TESTS PASSED!');
        process.exit(0);
    }
}

main();
