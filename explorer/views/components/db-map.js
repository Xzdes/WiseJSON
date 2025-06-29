// explorer/views/components/db-map.js

class DbMapComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.graphData = null;
        this.selectedCollection = null;

        // --- НОВОЕ: Свойства для логики перетаскивания ---
        this.isDragging = false;
        this.draggedNode = null;
        this.offsetX = 0;
        this.offsetY = 0;
        this.storageKey = 'wisejson-db-map-positions';
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    width: 100%;
                    height: 500px;
                    border: 1px solid #d1d5da;
                    border-radius: 6px;
                    background-color: #f6f8fa;
                    overflow: auto;
                    position: relative; /* Важно для абсолютного позиционирования холста */
                }
                .canvas {
                    /* --- ИЗМЕНЕНИЕ: Холст теперь позиционируется, а не имеет размера --- */
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 3000px; /* Задаем большой размер холста для перемещения */
                    height: 2000px;
                }
                .collection-node {
                    position: absolute;
                    background-color: white;
                    border: 1px solid #586069;
                    border-radius: 4px;
                    padding: 10px;
                    min-width: 200px;
                    font-family: monospace;
                    font-size: 13px;
                    cursor: grab; /* --- ИЗМЕНЕНИЕ: Курсор для перетаскивания --- */
                    box-shadow: 0 1px 5px rgba(27,31,35,.15);
                    transition: box-shadow 0.2s, transform 0.2s;
                    user-select: none; /* Предотвращаем выделение текста при перетаскивании */
                }
                .collection-node:active {
                    cursor: grabbing;
                    z-index: 1000;
                }
                .collection-node:hover {
                    box-shadow: 0 4px 10px rgba(27,31,35,.2);
                    transform: translateY(-2px);
                }
                .collection-node.selected {
                    border-color: #0366d6;
                    border-width: 2px;
                }
                .collection-node h3 {
                    margin: 0 0 10px 0;
                    padding-bottom: 5px;
                    border-bottom: 1px solid #e1e4e8;
                    font-size: 14px;
                    color: #0366d6;
                }
                .field-list { margin: 0; padding: 0; list-style: none; }
                .field-item { white-space: nowrap; }
                .field-item.indexed { font-weight: bold; color: #22863a; }
                .field-item .icon { display: inline-block; width: 16px; text-align: center; }
                .svg-links { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
                .svg-links path { stroke: #586069; stroke-width: 1.5; fill: none; }
            </style>
            <div class="canvas" id="canvas">
                <svg class="svg-links" id="svg-links"></svg>
            </div>
        `;
        this._canvas = this.shadowRoot.getElementById('canvas');
        this._svgLinks = this.shadowRoot.getElementById('svg-links');
        
        // --- НОВОЕ: Вешаем слушатели для перетаскивания ---
        this._canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        // Обработчики mousemove и mouseup будут добавляться к документу динамически
    }

    render(graphData) {
        this.graphData = graphData;
        const nodesContainer = document.createDocumentFragment();

        if (!graphData || !graphData.collections) return;

        const positions = this._initializeNodePositions(graphData.collections);

        graphData.collections.forEach(col => {
            const pos = positions[col.name];
            const nodeEl = this._createCollectionNode(col, pos);
            nodesContainer.appendChild(nodeEl);
        });
        
        // Очищаем и вставляем все сразу для производительности
        this._canvas.innerHTML = '';
        this._canvas.appendChild(this._svgLinks);
        this._canvas.appendChild(nodesContainer);

        this._drawLinks();
    }
    
    _initializeNodePositions(collections) {
        const savedPositions = this._loadPositions();
        const finalPositions = {};
        const PADDING = 50;
        const NODE_WIDTH = 220;
        const NODE_HEIGHT_ESTIMATE = 150;
        const COLS = Math.floor(this.offsetWidth / (NODE_WIDTH + PADDING)) || 1;
        let layoutIndex = 0;

        collections.forEach(col => {
            if (savedPositions && savedPositions[col.name]) {
                finalPositions[col.name] = savedPositions[col.name];
            } else {
                // Если позиция не сохранена, вычисляем ее по сетке
                const row = Math.floor(layoutIndex / COLS);
                const colIndex = layoutIndex % COLS;
                finalPositions[col.name] = {
                    x: PADDING + colIndex * (NODE_WIDTH + PADDING),
                    y: PADDING + row * (NODE_HEIGHT_ESTIMATE + PADDING),
                };
                layoutIndex++;
            }
        });
        return finalPositions;
    }

    _createCollectionNode(col, pos) {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'collection-node';
        nodeEl.style.left = `${pos.x}px`;
        nodeEl.style.top = `${pos.y}px`;
        nodeEl.dataset.collectionName = col.name;

        const fieldsHtml = col.fields.map(field => `
            <li class="field-item ${field.isIndexed ? 'indexed' : ''}">
                <span class="icon">${field.isIndexed ? (field.isUnique ? '🔑' : '⚡️') : '•'}</span>
                ${field.name}: <i>${field.types.join(', ')}</i>
            </li>
        `).join('');

        nodeEl.innerHTML = `<h3>${col.name} (${col.docCount})</h3><ul class="field-list">${fieldsHtml}</ul>`;
        return nodeEl;
    }

    _drawLinks() {
        if (!this.graphData || !this.graphData.links) return;
        this._svgLinks.innerHTML = '';
        this.graphData.links.forEach(link => {
            const sourceNode = this.shadowRoot.querySelector(`[data-collection-name="${link.source}"]`);
            const targetNode = this.shadowRoot.querySelector(`[data-collection-name="${link.target}"]`);
            if (!sourceNode || !targetNode) return;

            const startX = parseFloat(sourceNode.style.left) + sourceNode.offsetWidth;
            const startY = parseFloat(sourceNode.style.top) + sourceNode.offsetHeight / 2;
            const endX = parseFloat(targetNode.style.left);
            const endY = parseFloat(targetNode.style.top) + targetNode.offsetHeight / 2;
            
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const d = `M ${startX} ${startY} C ${startX + 50} ${startY}, ${endX - 50} ${endY}, ${endX} ${endY}`;
            path.setAttribute('d', d);
            this._svgLinks.appendChild(path);
        });
    }

    // --- НОВОЕ: Методы для перетаскивания и сохранения ---

    _onMouseDown(e) {
        const node = e.target.closest('.collection-node');
        if (!node) return;
        
        e.preventDefault(); // Предотвращаем стандартное поведение (например, выделение текста)
        this.draggedNode = node;
        this.isDragging = true;

        this.offsetX = e.clientX - this.draggedNode.offsetLeft + this.scrollLeft;
        this.offsetY = e.clientY - this.draggedNode.offsetTop + this.scrollTop;

        // Привязываем обработчики к документу, чтобы перетаскивание работало за пределами узла
        this.onMouseMove = (ev) => this._onMouseMove(ev);
        this.onMouseUp = () => this._onMouseUp();
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp, { once: true }); // сработает один раз и удалится
    }

    _onMouseMove(e) {
        if (!this.isDragging) return;
        e.preventDefault();
        
        let newX = e.clientX - this.offsetX + this.scrollLeft;
        let newY = e.clientY - this.offsetY + this.scrollTop;
        
        // Ограничиваем перемещение в пределах холста
        newX = Math.max(0, newX);
        newY = Math.max(0, newY);
        
        this.draggedNode.style.left = `${newX}px`;
        this.draggedNode.style.top = `${newY}px`;
        
        // Перерисовываем связи в реальном времени
        this._drawLinks();
    }

    _onMouseUp() {
        if (!this.isDragging) return;
        this.isDragging = false;
        document.removeEventListener('mousemove', this.onMouseMove);
        this._savePositions();
        
        // Выделяем узел после перетаскивания
        this._handleNodeSelection(this.draggedNode);
    }
    
    _handleNodeSelection(node) {
        if (!node) return;
        const collectionName = node.dataset.collectionName;
        this.shadowRoot.querySelectorAll('.collection-node').forEach(n => n.classList.remove('selected'));
        node.classList.add('selected');
        this.selectedCollection = collectionName;
        this.dispatchEvent(new CustomEvent('collection-selected', {
            detail: { collectionName }, bubbles: true, composed: true
        }));
    }

    _savePositions() {
        const positions = {};
        this.shadowRoot.querySelectorAll('.collection-node').forEach(node => {
            const name = node.dataset.collectionName;
            positions[name] = {
                x: parseFloat(node.style.left),
                y: parseFloat(node.style.top),
            };
        });
        localStorage.setItem(this.storageKey, JSON.stringify(positions));
    }

    _loadPositions() {
        try {
            const saved = localStorage.getItem(this.storageKey);
            return saved ? JSON.parse(saved) : null;
        } catch (e) {
            console.error("Failed to load node positions from localStorage", e);
            return null;
        }
    }
}

customElements.define('db-map', DbMapComponent);