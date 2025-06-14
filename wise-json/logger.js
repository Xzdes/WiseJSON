// wise-json/logger.js

const colors = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

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
const envLevel = process.env.LOG_LEVEL ? String(process.env.LOG_LEVEL).toLowerCase() : null;
const defaultLogLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'log';
let currentLevel;

if (envLevel === 'none') {
  currentLevel = -1; // Уровень, который отключит все логи
} else {
  currentLevel = levels[envLevel] !== undefined ? levels[envLevel] : levels[defaultLogLevel];
}

const NO_COLOR = process.env.LOG_NO_COLOR === 'true';

function safeArgsToString(args) {
    try {
        return args.map(arg => {
            if (arg instanceof Error) return arg.stack || arg.message;
            if (typeof arg === 'object' && arg !== null) {
                try { return JSON.stringify(arg); } catch (e) { return '[Unserializable Object]'; }
            }
            return String(arg);
        }).join(" ");
    } catch (e) {
        console.error('[Logger Internal Error] Failed to process arguments for logging:', e);
        return '[Error processing log arguments]';
    }
}

function format(level, msg) {
  const ts = new Date().toISOString();
  if (NO_COLOR) {
    return `[${ts}] [${level.toUpperCase()}] ${msg}`;
  }
  const color = colorMap[level] || colors.reset;
  return `${color}[${ts}] [${level.toUpperCase()}]${colors.reset} ${msg}`;
}

const logger = {
  error(...args) {
    if (currentLevel >= levels.error) { // Проверка уровня ДО вызова console
      console.error(format("error", safeArgsToString(args)));
    }
  },

  warn(...args) {
    if (currentLevel >= levels.warn) { // Проверка уровня ДО вызова console
      // Используем console.log для warn, чтобы не загрязнять stderr в тестах, если не нужно
      console.log(format("warn", safeArgsToString(args)));
    }
  },

  log(...args) {
    if (currentLevel >= levels.log) { // Проверка уровня ДО вызова console
      console.log(format("log", safeArgsToString(args)));
    }
  },

  debug(...args) {
    if (currentLevel >= levels.debug) { // Проверка уровня ДО вызова console
      console.log(format("debug", safeArgsToString(args)));
    }
  },

  getLevel() {
    return Object.keys(levels).find(k => levels[k] === currentLevel) || 'none';
  },
  
  levels: { ...levels }
};

module.exports = logger;