// explorer/views/components/toast-notifications.js

class ToastNotificationsComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    z-index: 9999;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    pointer-events: none; /* Уведомления не должны мешать кликать по элементам под ними */
                }
                .toast {
                    padding: 12px 20px;
                    border-radius: 6px;
                    color: white;
                    font-weight: 600;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                    animation: slideIn 0.3s ease-out, fadeOut 0.5s ease-in 2.5s forwards;
                }
                .toast.success { background-color: #2ea44f; }
                .toast.error { background-color: #d73a49; }
                .toast.info { background-color: #0366d6; }

                @keyframes slideIn {
                    from { opacity: 0; transform: translateX(100%); }
                    to { opacity: 1; transform: translateX(0); }
                }
                @keyframes fadeOut {
                    from { opacity: 1; transform: scale(1); }
                    to { opacity: 0; transform: scale(0.9); }
                }
            </style>
            <div id="container"></div>
        `;
        this.container = this.shadowRoot.getElementById('container');
    }

    /**
     * Показывает уведомление.
     * @param {string} message - Текст сообщения.
     * @param {string} type - 'success', 'error', или 'info'.
     */
    show(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        
        this.container.appendChild(toast);

        // Удаляем элемент из DOM после завершения анимации
        setTimeout(() => {
            toast.remove();
        }, 3000); // 3 секунды = 2.5с задержка + 0.5с анимация
    }
}

customElements.define('toast-notifications', ToastNotificationsComponent);