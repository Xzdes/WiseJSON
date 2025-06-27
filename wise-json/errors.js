// wise-json/errors.js

/**
 * Базовый класс для всех кастомных ошибок, генерируемых WiseJSON DB.
 * Позволяет ловить все ошибки библиотеки через `catch (e if e instanceof WiseJSONError)`.
 */
class WiseJSONError extends Error {
  /**
   * @param {string} message - Сообщение об ошибке.
   */
  constructor(message) {
    super(message);
    // Устанавливаем имя конструктора как имя ошибки для легкой идентификации.
    this.name = this.constructor.name;
    // Сохраняем стек вызовов (полезно для отладки).
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Ошибка, возникающая при попытке нарушить ограничение уникальности индекса.
 * Например, при вставке документа со значением, которое уже существует в уникальном индексе.
 */
class UniqueConstraintError extends WiseJSONError {
  /**
   * @param {string} fieldName - Имя поля с уникальным индексом.
   * @param {*} value - Значение, которое вызвало конфликт.
   */
  constructor(fieldName, value) {
    const valueStr = typeof value === 'string' ? `'${value}'` : value;
    super(`Duplicate value ${valueStr} for unique index on field '${fieldName}'.`);
    this.fieldName = fieldName;
    this.value = value;
  }
}

/**
 * Ошибка, возникающая, когда операция не может быть выполнена,
 * так как ожидаемый документ не был найден по указанному ID.
 * (Примечание: getById просто возвращает null, а вот update или remove могут бросать эту ошибку, если это требуется логикой).
 */
class DocumentNotFoundError extends WiseJSONError {
  /**
   * @param {string} docId - ID документа, который не был найден.
   */
  constructor(docId) {
    super(`Document with ID '${docId}' not found.`);
    this.docId = docId;
  }
}

/**
 * Ошибка, связанная с некорректной конфигурацией, опциями или неверным использованием API.
 * Например, передача невалидных аргументов в метод.
 */
class ConfigurationError extends WiseJSONError {
  /**
   * @param {string} message - Описание ошибки конфигурации.
   */
  constructor(message) {
    super(message);
  }
}


module.exports = {
  WiseJSONError,
  UniqueConstraintError,
  DocumentNotFoundError,
  ConfigurationError,
};