const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * ApiClient - это низкоуровневый клиент для взаимодействия с удаленным сервером WiseJSON.
 * Он отвечает за формирование, отправку HTTP-запросов и обработку ответов.
 */
class ApiClient {
    /**
     * @param {string} baseUrl - Полный URL сервера, например, 'https://api.example.com/wisejson'.
     * @param {string} apiKey - Ключ API для аутентификации.
     */
    constructor(baseUrl, apiKey) {
        if (!baseUrl || !apiKey) {
            throw new Error('ApiClient требует baseUrl и apiKey для инициализации.');
        }
        this.baseUrl = new URL(baseUrl);
        this.apiKey = apiKey;
        this.agent = this.baseUrl.protocol === 'https:' ? https : http;
    }

    /**
     * Основной метод для выполнения запросов.
     * @private
     * @param {string} method - HTTP-метод ('GET', 'POST', и т.д.).
     * @param {string} path - Путь запроса (например, '/sync/pull').
     * @param {object|null} body - Тело запроса для методов POST/PUT.
     * @returns {Promise<any>} - Промис, который разрешается с распарсенным JSON-ответом.
     */
    _request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const requestPath = this.baseUrl.pathname.endsWith('/')
                ? `${this.baseUrl.pathname.slice(0, -1)}${path}`
                : `${this.baseUrl.pathname}${path}`;

            const options = {
                hostname: this.baseUrl.hostname,
                port: this.baseUrl.port,
                path: requestPath,
                method: method.toUpperCase(),
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                }
            };

            if (body) {
                options.headers['Content-Type'] = 'application/json';
            }

            const req = this.agent.request(options, (res) => {
                let responseData = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        let error;
                        try {
                            const errorPayload = JSON.parse(responseData);
                            error = new Error(errorPayload.error || `Сервер вернул ошибку ${res.statusCode}`);
                        } catch (e) {
                            error = new Error(`Сервер вернул ошибку ${res.statusCode} с не-JSON телом: ${responseData}`);
                        }
                        error.statusCode = res.statusCode;
                        return reject(error);
                    }

                    if (res.statusCode === 204 || responseData.length === 0) {
                        return resolve(null); // No Content
                    }

                    try {
                        const parsedData = JSON.parse(responseData);
                        resolve(parsedData);
                    } catch (e) {
                        reject(new Error('Не удалось распарсить JSON-ответ от сервера.'));
                    }
                });
            });

            req.on('error', (e) => {
                reject(new Error(`Сетевая ошибка при запросе: ${e.message}`));
            });

            if (body) {
                try {
                    req.write(JSON.stringify(body));
                } catch(e) {
                    return reject(new Error(`Ошибка сериализации тела запроса: ${e.message}`));
                }
            }

            req.end();
        });
    }

    /**
     * Выполняет GET-запрос.
     * @param {string} path - Путь запроса.
     * @returns {Promise<any>}
     */
    get(path) {
        return this._request('GET', path);
    }

    /**
     * Выполняет POST-запрос.
     * @param {string} path - Путь запроса.
     * @param {object} body - Тело запроса.
     * @returns {Promise<any>}
     */
    post(path, body) {
        return this._request('POST', path, body);
    }
}

module.exports = ApiClient;