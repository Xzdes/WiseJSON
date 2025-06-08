// wise-json/logger.js

/**
 * Лёгкая абстракция для централизованного логирования в проекте wise-json.
 * Уровень задаётся через переменную окружения LOG_LEVEL (error, warn, log, debug).
 * По умолчанию для продакшена: warn. Для разработки/тестов: log.
 * Отключение цветов через LOG_NO_COLOR=true.
 * 
 * Логгер спроектирован так, чтобы ошибки внутри него самого (например, при форматировании)
 * не приводили к падению основного приложения.
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
  log: 2,
  debug: 3,
};

const colorMap = {
  error: colors.red,
  warn: colors.yellow,
  log: colors.cyan,
  debug: colors.gray,
};

// --- Конфигурация ---
const envLevel = process.env.LOG_LEVEL && typeof process.env.LOG_LEVEL === "string"
  ? process.env.LOG_LEVEL.toLowerCase()
  : null;

// По умолчанию: 'warn' для 'production' окружения, иначе 'log'
const defaultLogLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'log';
const currentLevel = envLevel && levels[envLevel] !== undefined ? levels[envLevel] : levels[defaultLogLevel];

const NO_COLOR = process.env.LOG_NO_COLOR === 'true';

/**
 * Безопасное преобразование аргументов в строку.
 * @param {any[]} args 
 * @returns {string}
 */
function safeArgsToString(args) {
    try {
        return args.map(arg => {
            if (arg instanceof Error) {
                return arg.stack || arg.message; // Для ошибок выводим стек
            }
            if (typeof arg === 'object' && arg !== null) {
                try {
                    return JSON.stringify(arg); // Пытаемся сериализовать объекты
                } catch (e) {
                    return '[Unserializable Object]';
                }
            }
            return String(arg); // Для примитивов и всего остального
        }).join(" ");
    } catch (e) {
        // Крайне маловероятно, но на всякий случай
        console.error('[Logger Internal Error] Failed to process arguments for logging:', e);
        return '[Error processing log arguments]';
    }
}


/**
 * Форматирует сообщение с датой, уровнем и цветом (если включено).
 * @param {string} level - Уровень логирования (error|warn|log|debug)
 * @param {string} msg - Сообщение
 * @returns {string}
 */
function format(level, msg) {
  try {
    const ts = new Date().toISOString();
    if (NO_COLOR) {
      return `[${ts}] [${level.toUpperCase()}] ${msg}`;
    }
    const color = colorMap[level] || colors.reset; // Защита, если level некорректен
    return `${color}[${ts}] [${level.toUpperCase()}]${colors.reset} ${msg}`;
  } catch (e) {
    // Если ошибка при форматировании, возвращаем "сырое" сообщение, чтобы не потерять его
    console.error('[Logger Internal Error] Failed to format log message:', e);
    return `[RAW - ${level.toUpperCase()}] ${msg}`;
  }
}

const logger = {
  /**
   * Лог ошибок. Всегда выводится, если уровень позволяет.
   * @param {...any} args
   */
  error(...args) {
    if (currentLevel >= levels.error) {
      try {
        const message = safeArgsToString(args);
        console.error(format("error", message));
      } catch (e) {
        // Если даже console.error падает (например, дескриптор закрыт), мы мало что можем сделать,
        // но основное приложение не должно упасть из-за логгера.
        // Этот catch здесь больше для демонстрации идеи "не падать".
        // В реальности, если console.error не работает, проблема глубже.
      }
    }
  },

  /**
   * Лог предупреждений.
   * @param {...any} args
   */
  warn(...args) {
    if (currentLevel >= levels.warn) {
      try {
        const message = safeArgsToString(args);
        console.warn(format("warn", message));
      } catch (e) {
        // Аналогично error
      }
    }
  },

  /**
   * Основной информационный лог.
   * @param {...any} args
   */
  log(...args) {
    if (currentLevel >= levels.log) {
      try {
        const message = safeArgsToString(args);
        console.log(format("log", message));
      } catch (e) {
        // Аналогично error
      }
    }
  },

  /**
   * Отладочный лог.
   * @param {...any} args
   */
  debug(...args) {
    if (currentLevel >= levels.debug) {
      try {
        const message = safeArgsToString(args);
        console.log(format("debug", message)); // Используем console.log для debug
      } catch (e) {
        // Аналогично error
      }
    }
  },

  /**
   * Возвращает текущий уровень логирования в виде строки.
   * @returns {string}
   */
  getLevel() {
    return Object.keys(levels).find((k) => levels[k] === currentLevel) || defaultLogLevel;
  },

  /**
   * Возвращает числовое представление текущего уровня логирования.
   * @returns {number}
   */
  getCurrentLevelNumber() {
    return currentLevel;
  },

  levels: { ...levels } // Экспортируем уровни, если нужно сравнение извне
};

module.exports = logger;