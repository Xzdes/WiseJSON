// wise-json/logger.js

/**
 * Лёгкая абстракция для централизованного логирования в проекте wise-json.
 * Уровень задаётся через переменную окружения LOG_LEVEL (error, warn, log, debug).
 * По умолчанию: log.
 */

// Цвета для терминала
const colors = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

// Уровни логирования
const levels = {
  error: 0,
  warn: 1,
  log: 2,    // Был info, теперь log
  debug: 3,
};

const colorMap = {
  error: colors.red,
  warn: colors.yellow,
  log: colors.cyan,     // Был info, теперь log
  debug: colors.gray,
};

// Получаем уровень логирования из переменной окружения
const envLevel = process.env.LOG_LEVEL && typeof process.env.LOG_LEVEL === "string"
  ? process.env.LOG_LEVEL.toLowerCase()
  : null;

const currentLevel = envLevel && levels[envLevel] !== undefined ? levels[envLevel] : levels.log;

/**
 * Форматирует сообщение с датой, уровнем и цветом.
 * @param {string} level - Уровень логирования (error|warn|log|debug)
 * @param {string} msg - Сообщение
 * @returns {string}
 */
function format(level, msg) {
  const ts = new Date().toISOString();
  return `${colorMap[level]}[${ts}] [${level.toUpperCase()}]${colors.reset} ${msg}`;
}

module.exports = {
  /**
   * Лог ошибок. Всегда выводится.
   * @param {...any} args
   */
  error(...args) {
    if (currentLevel >= levels.error) {
      console.error(format("error", args.map(String).join(" ")));
    }
  },

  /**
   * Лог предупреждений. Выводится если уровень warn или ниже.
   * @param {...any} args
   */
  warn(...args) {
    if (currentLevel >= levels.warn) {
      console.warn(format("warn", args.map(String).join(" ")));
    }
  },

  /**
   * Основной информационный лог. Аналог console.log.
   * @param {...any} args
   */
  log(...args) {
    if (currentLevel >= levels.log) {
      console.log(format("log", args.map(String).join(" ")));
    }
  },

  /**
   * Отладочный лог. Только при LOG_LEVEL=debug.
   * @param {...any} args
   */
  debug(...args) {
    if (currentLevel >= levels.debug) {
      console.log(format("debug", args.map(String).join(" ")));
    }
  },

  /**
   * Возвращает текущий уровень логирования.
   * @returns {string}
   */
  getLevel() {
    return Object.keys(levels).find((k) => levels[k] === currentLevel);
  },
};
