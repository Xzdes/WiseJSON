// explorer/views/components/json-viewer.js

class JsonViewerComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    width: 100%;
                }
                pre {
                    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
                    font-size: 13px;
                    background-color: #f6f8fa;
                    border: 1px solid #d1d5da;
                    border-radius: 6px;
                    padding: 10px;
                    margin: 0;
                    box-sizing: border-box;
                    white-space: pre-wrap; /* Перенос строк */
                    word-wrap: break-word; /* Перенос длинных слов */
                    color: #24292e;
                    height: 200px; /* Высота по умолчанию */
                    overflow-y: auto;
                }
                .key { color: #005cc5; }
                .string { color: #032f62; }
                .number { color: #d73a49; }
                .boolean { color: #56239a; }
                .null { color: #6a737d; }
            </style>
            <pre id="content"></pre>
        `;
        this._contentElement = this.shadowRoot.getElementById('content');
    }

    /**
     * Статический геттер, чтобы указать, за какими атрибутами следить.
     */
    static get observedAttributes() {
        return ['value'];
    }

    /**
     * Вызывается при изменении атрибутов, перечисленных в observedAttributes.
     */
    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'value') {
            this.render(newValue);
        }
    }

    /**
     * Публичный метод для установки значения.
     * @param {string | object} data - Данные для отображения.
     */
    set value(data) {
        const valueString = (typeof data === 'object')
            ? JSON.stringify(data, null, 2)
            : String(data);
        this.setAttribute('value', valueString);
    }
    
    get value() {
        return this.getAttribute('value');
    }

    /**
     * Рендерит отформатированный и подсвеченный JSON.
     * @param {string} jsonString
     */
    render(jsonString) {
        if (!jsonString) {
            this._contentElement.textContent = '';
            return;
        }

        try {
            // Убедимся, что это валидный JSON, и переформатируем его
            const jsonObj = JSON.parse(jsonString);
            const formattedJson = JSON.stringify(jsonObj, null, 2);
            this._contentElement.innerHTML = this._syntaxHighlight(formattedJson);
        } catch (e) {
            // Если это не JSON, просто отображаем как текст
            this._contentElement.textContent = jsonString;
        }
    }

    _syntaxHighlight(json) {
        json = json.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
            let cls = 'number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'key';
                } else {
                    cls = 'string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'boolean';
            } else if (/null/.test(match)) {
                cls = 'null';
            }
            return `<span class="${cls}">${match}</span>`;
        });
    }
}

customElements.define('json-viewer', JsonViewerComponent);