// collection/events.js

/**
 * Класс EventEmitter для локальных событий в Collection.
 */
class CollectionEventEmitter {
    constructor(collectionName) {
        this._listeners = {};
        this._collectionName = collectionName || 'unnamed';
    }

    /**
     * Подписка на событие.
     * @param {string} eventName
     * @param {Function} listener
     */
    on(eventName, listener) {
        if (typeof listener !== 'function') {
            throw new Error(`Collection (${this._collectionName}): listener должен быть функцией.`);
        }
        if (!this._listeners[eventName]) {
            this._listeners[eventName] = [];
        }
        this._listeners[eventName].push(listener);
    }

    /**
     * Отписка от события. Если listener не указан — удаляет всех.
     * @param {string} eventName
     * @param {Function} [listener]
     */
    off(eventName, listener) {
        if (!this._listeners[eventName]) return;

        if (!listener) {
            delete this._listeners[eventName];
        } else {
            this._listeners[eventName] = this._listeners[eventName].filter(l => l !== listener);
            if (this._listeners[eventName].length === 0) {
                delete this._listeners[eventName];
            }
        }
    }

    /**
     * Вызов события.
     * @param {string} eventName
     * @param  {...any} args
     */
    emit(eventName, ...args) {
        const listeners = this._listeners[eventName];
        if (!listeners || listeners.length === 0) return;

        const filteredArgs = args.filter(arg => arg !== undefined);

        for (const listener of listeners) {
            try {
                const result = listener(...filteredArgs);
                if (result instanceof Promise) {
                    result.catch(e =>
                        console.error(`Collection (${this._collectionName}) async event error '${eventName}': ${e.message}`)
                    );
                }
            } catch (e) {
                console.error(`Collection (${this._collectionName}) sync event error '${eventName}': ${e.message}`);
            }
        }
    }
}

module.exports = CollectionEventEmitter;
