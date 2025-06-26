// cli/utils.js

const readline = require('readline');
const logger = require('../wise-json/logger');

/**
 * Продвинутый парсер аргументов командной строки.
 * Разделяет позиционные аргументы и именованные опции (флаги).
 * Корректно обрабатывает значения, содержащие '='.
 * Поддерживает: --flag, --option=value
 * @param {string[]} rawCliArgs - Массив process.argv.slice(2).
 * @returns {{args: string[], options: object}}
 */
function parseArgs(rawCliArgs) {
  const options = {};
  const args = [];

  for (const arg of rawCliArgs) {
    if (arg.startsWith('--')) {
      const parts = arg.slice(2).split('=');
      const key = parts[0];
      // Все, что после первого '=', - это значение.
      const value = parts.slice(1).join('=');

      // Флаг без значения (e.g., --force, --unique)
      if (value === '') {
        options[key] = true;
      } else {
        // Опция со значением (e.g., --limit=10)
        options[key] = value;
      }
    } else {
      // Это позиционный аргумент
      args.push(arg);
    }
  }
  return { args, options };
}

/**
 * Выводит форматированную ошибку и завершает процесс.
 * @param {string} msg - Сообщение об ошибке.
 * @param {object} [options={}]
 * @param {boolean} [options.json=false] - Выводить ошибку в формате JSON.
 * @param {number} [options.code=1] - Код завершения процесса.
 */
function prettyError(msg, { json = false, code = 1 } = {}) {
  if (json) {
    console.error(JSON.stringify({ error: true, message: msg, code }));
  } else {
    logger.error(msg);
  }
  process.exit(code);
}

/**
 * Запрашивает у пользователя подтверждение в интерактивном режиме.
 * @param {string} prompt - Вопрос для пользователя.
 * @param {object} options - Опции, полученные из parseArgs.
 * @returns {Promise<boolean>}
 */
async function confirmAction(prompt, options) {
  if (options.force || options.yes) {
    return true;
  }
  
  if (!process.stdin.isTTY) {
    // В неинтерактивной среде (например, в тестах `execSync` без tty)
    // запрос на ввод заблокирует процесс. Считаем, что пользователь не согласился.
    // Это заставит тест `collection-drop` без `--force` упасть, что является правильным поведением.
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${prompt} [y/N] `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

module.exports = {
  parseArgs,
  prettyError,
  confirmAction,
};