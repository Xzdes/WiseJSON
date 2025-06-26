#!/usr/bin/env node

const path = require('path');
const WiseJSON = require('../wise-json/index.js');
const commandRegistry = require('./actions.js');
const { parseArgs, prettyError } = require('./utils.js');

const DB_PATH = process.env.WISE_JSON_PATH || path.resolve(process.cwd(), 'wise-json-db-data');

function printHelp() {
    console.log('WiseJSON DB Unified CLI\n');
    console.log('Usage: wise-json <command> [args...] [--options...]\n');
    console.log('Global Options:');
    console.log('  --allow-write    Required for any command that modifies data.');
    console.log('  --force, --yes   Skip confirmation prompts for dangerous operations.');
    console.log('  --json-errors    Output errors in JSON format.');
    console.log('  --help           Show this help message.\n');
    console.log('Available Commands:');
    
    // Форматируем вывод помощи
    const commands = Object.entries(commandRegistry);
    const maxLen = Math.max(...commands.map(([name]) => name.length));
    
    commands.forEach(([name, { description }]) => {
        console.log(`  ${name.padEnd(maxLen + 2)} ${description || ''}`);
    });
}

async function main() {
  const allCliArgs = process.argv.slice(2);
  const { args, options } = parseArgs(allCliArgs);
  const commandName = args.shift();

  if (!commandName || options.help) {
    printHelp();
    return;
  }

  const command = commandRegistry[commandName];
  if (!command) {
    return prettyError(`Unknown command: "${commandName}". Use --help for usage.`);
  }

  if (command.isWrite && !options['allow-write']) {
    return prettyError(`Write command "${commandName}" requires the --allow-write flag.`);
  }

  const db = new WiseJSON(DB_PATH, {
    ttlCleanupIntervalMs: 0,
    checkpointIntervalMs: 0,
  });

  try {
    await db.init();
    // Передаем весь контекст в обработчик
    await command.handler(db, args, options);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

// Перехватываем ошибки и выводим через нашу утилиту
main().catch(err => {
  // Проверяем, есть ли опция json-errors в оригинальных аргументах
  const jsonErrors = process.argv.slice(2).includes('--json-errors');
  prettyError(err.message, { json: jsonErrors });
});