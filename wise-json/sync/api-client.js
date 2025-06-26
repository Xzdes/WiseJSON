// wise-json/sync/api-client.js

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * ApiClient - a low-level client for interacting with a remote WiseJSON server.
 * It is responsible for creating and sending HTTP requests and handling responses.
 */
class ApiClient {
    /**
     * @param {string} baseUrl - The full base URL of the server, e.g., 'https://api.example.com'.
     * @param {string} apiKey - The API key for authentication.
     * @param {object} [endpoints={}] - Optional custom endpoint paths.
     */
    constructor(baseUrl, apiKey, endpoints = {}) {
        if (!baseUrl || !apiKey) {
            throw new Error('ApiClient requires baseUrl and apiKey for initialization.');
        }
        this.baseUrl = new URL(baseUrl);
        this.apiKey = apiKey;
        this.agent = this.baseUrl.protocol === 'https:' ? https : http;

        // УЛУЧШЕНИЕ: Делаем эндпоинты настраиваемыми
        this.endpoints = {
            snapshot: '/sync/snapshot',
            pull: '/sync/pull',
            push: '/sync/push',
            health: '/sync/health',
            ...endpoints,
        };
    }

    /**
     * The core method for making requests.
     * @private
     * @param {string} method - The HTTP method ('GET', 'POST', etc.).
     * @param {string} path - The request path (e.g., '/sync/pull').
     * @param {object|null} body - The request body for POST/PUT methods.
     * @returns {Promise<any>} A promise that resolves with the parsed JSON response.
     */
    _request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const requestPath = this.baseUrl.pathname.endsWith('/')
                ? `${this.baseUrl.pathname.slice(0, -1)}${path}`
                : `${this.baseUrl.pathname}${path}`;

            const options = {
                hostname: this.baseUrl.hostname,
                port: this.baseUrl.port || (this.baseUrl.protocol === 'https:' ? 443 : 80),
                path: requestPath,
                method: method.toUpperCase(),
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                timeout: 15000, // 15-секундный таймаут для запросов
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
                            error = new Error(errorPayload.error || `Server returned error ${res.statusCode}`);
                        } catch (e) {
                            error = new Error(`Server returned error ${res.statusCode} with non-JSON body: ${responseData}`);
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
                        reject(new Error(`Failed to parse JSON response from server. Raw response: ${responseData}`));
                    }
                });
            });
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out after 15 seconds.'));
            });

            req.on('error', (e) => {
                reject(new Error(`Network error during request: ${e.message}`));
            });

            if (body) {
                try {
                    req.write(JSON.stringify(body));
                } catch (e) {
                    return reject(new Error(`Failed to serialize request body: ${e.message}`));
                }
            }

            req.end();
        });
    }

    /**
     * Performs a GET request.
     * @param {string} path - The request path.
     * @returns {Promise<any>}
     */
    get(path) {
        return this._request('GET', path);
    }

    /**
     * Performs a POST request.
     * @param {string} path - The request path.
     * @param {object} body - The request body.
     * @returns {Promise<any>}
     */
    post(path, body) {
        return this._request('POST', path, body);
    }
}

module.exports = ApiClient;