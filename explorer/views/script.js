// explorer/views/script.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Глобальные переменные и состояние ---
    const state = {
        collections: [],
        currentCollection: null,
        documents: [],
        indexes: [],
        currentPage: 0,
        pageSize: 10,
        totalDocs: 0, // Приблизительное количество для пагинации
        filter: {},
        sort: { field: '_id', order: 'asc' },
        writeMode: false,
    };

    // --- DOM элементы ---
    const collectionSelect = document.getElementById('collectionSelect');
    const refreshBtn = document.getElementById('refreshBtn');
    const applyBtn = document.getElementById('applyBtn');
    const filterInput = document.getElementById('filterInput');
    const sortInput = document.getElementById('sortInput');
    const orderSelect = document.getElementById('orderSelect');
    const pageSizeInput = document.getElementById('pageSizeInput');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const pageInfo = document.getElementById('pageInfo');
    const dataTable = document.getElementById('dataTable');
    const documentViewer = document.getElementById('documentViewer');
    const indexList = document.getElementById('index-list');
    const createIndexForm = document.getElementById('create-index-form');
    const indexFieldInput = document.getElementById('indexFieldInput');
    const uniqueCheckbox = document.getElementById('uniqueCheckbox');
    const createIndexBtn = document.getElementById('createIndexBtn');
    const serverModeEl = document.getElementById('server-mode');

    // --- API Функции ---
    async function apiFetch(url, options = {}) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }
            // Для DELETE запросов, которые могут не вернуть тело
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) {
                return response.json();
            }
            return {};
        } catch (error) {
            alert(`API Error: ${error.message}`);
            console.error('API Fetch Error:', error);
            throw error;
        }
    }

    // --- Функции рендеринга ---

    function renderCollections() {
        collectionSelect.innerHTML = '<option value="">-- Select a collection --</option>';
        state.collections.forEach(col => {
            const option = document.createElement('option');
            option.value = col.name;
            option.textContent = `${col.name} (${col.count} docs)`;
            collectionSelect.appendChild(option);
        });
        if (state.currentCollection) {
            collectionSelect.value = state.currentCollection;
        }
    }

    function renderDocuments() {
        const thead = dataTable.querySelector('thead');
        const tbody = dataTable.querySelector('tbody');
        thead.innerHTML = '';
        tbody.innerHTML = '';

        if (state.documents.length === 0) {
            tbody.innerHTML = '<tr><td colspan="100%">No documents found for the current selection.</td></tr>';
            return;
        }

        const headers = new Set(['_actions']);
        state.documents.forEach(doc => Object.keys(doc).forEach(key => headers.add(key)));
        
        const headerRow = document.createElement('tr');
        headers.forEach(key => {
            const th = document.createElement('th');
            th.textContent = key;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);

        state.documents.forEach(doc => {
            const row = document.createElement('tr');
            row.addEventListener('click', () => {
                documentViewer.value = JSON.stringify(doc, null, 2);
                document.querySelectorAll('#dataTable tr').forEach(r => r.classList.remove('selected'));
                row.classList.add('selected');
            });

            headers.forEach(header => {
                const td = document.createElement('td');
                if (header === '_actions') {
                    const viewBtn = document.createElement('button');
                    viewBtn.textContent = 'View';
                    viewBtn.onclick = (e) => {
                         e.stopPropagation();
                         documentViewer.value = JSON.stringify(doc, null, 2);
                    };
                    td.appendChild(viewBtn);

                    if (state.writeMode) {
                        const deleteBtn = document.createElement('button');
                        deleteBtn.textContent = 'Delete';
                        deleteBtn.className = 'delete-btn write-op';
                        deleteBtn.onclick = (e) => {
                            e.stopPropagation();
                            handleDeleteDocument(doc._id);
                        };
                        td.appendChild(deleteBtn);
                    }
                } else {
                    const value = doc[header];
                    td.textContent = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value;
                }
                row.appendChild(td);
            });
            tbody.appendChild(row);
        });
    }
    
    function renderIndexes() {
        indexList.innerHTML = '';
        if (state.indexes.length === 0) {
            indexList.innerHTML = '<p>No indexes defined for this collection.</p>';
        } else {
            state.indexes.forEach(index => {
                const item = document.createElement('div');
                item.className = `index-item ${index.type}`;
                item.textContent = index.fieldName;
                if (state.writeMode) {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.textContent = '×';
                    deleteBtn.className = 'delete-btn write-op';
                    deleteBtn.title = `Delete index on ${index.fieldName}`;
                    deleteBtn.onclick = () => handleDeleteIndex(index.fieldName);
                    item.appendChild(deleteBtn);
                }
                indexList.appendChild(item);
            });
        }
    }

    function renderPagination() {
        pageInfo.textContent = `Page ${state.currentPage + 1}`;
        prevBtn.disabled = state.currentPage === 0;
        // Приблизительная логика для кнопки "Next"
        nextBtn.disabled = state.documents.length < state.pageSize;
    }
    
    function updateWriteModeUI() {
        document.querySelectorAll('.write-op').forEach(el => {
            el.style.display = state.writeMode ? 'inline-block' : 'none';
        });
        if (state.writeMode) {
            serverModeEl.textContent = 'Server Mode: Write-Enabled';
            serverModeEl.className = 'server-mode-write-enabled';
        }
    }

    // --- Логика обработчиков событий ---

    async function loadInitialData() {
        try {
            state.collections = await apiFetch('/api/collections');
            renderCollections();
            // Попытка определить, включен ли режим записи
            const testWrite = await fetch(`/api/collections/test/indexes/test`, { method: 'DELETE' });
            state.writeMode = testWrite.status !== 403;
            updateWriteModeUI();
        } catch (e) { /* ignore */ }
    }

    async function loadCollectionData() {
        if (!state.currentCollection) return;
        
        // Загрузка документов
        const offset = state.currentPage * state.pageSize;
        const query = new URLSearchParams({
            limit: state.pageSize,
            offset: offset,
            sort: state.sort.field,
            order: state.sort.order,
            filter: JSON.stringify(state.filter)
        });
        state.documents = await apiFetch(`/api/collections/${state.currentCollection}?${query}`);
        
        // Загрузка статистики и индексов
        const statsData = await apiFetch(`/api/collections/${state.currentCollection}/stats`);
        state.indexes = statsData.indexes || [];
        
        renderDocuments();
        renderIndexes();
        renderPagination();
    }

    async function handleSelectCollection() {
        state.currentCollection = collectionSelect.value;
        state.currentPage = 0;
        if (state.currentCollection) {
            await loadCollectionData();
        } else {
            // Очистить все
            state.documents = [];
            state.indexes = [];
            renderDocuments();
            renderIndexes();
        }
    }

    function handleApplyFilters() {
        state.currentPage = 0;
        try {
            state.filter = filterInput.value ? JSON.parse(filterInput.value) : {};
        } catch (e) {
            alert('Invalid JSON in filter input.');
            return;
        }
        state.sort.field = sortInput.value || '_id';
        state.sort.order = orderSelect.value;
        state.pageSize = parseInt(pageSizeInput.value, 10) || 10;
        loadCollectionData();
    }
    
    async function handleDeleteDocument(docId) {
        if (!confirm(`Are you sure you want to delete document with ID: ${docId}?`)) return;
        await apiFetch(`/api/collections/${state.currentCollection}/doc/${docId}`, { method: 'DELETE' });
        loadCollectionData(); // Перезагрузить данные
    }
    
    async function handleCreateIndex() {
        const fieldName = indexFieldInput.value.trim();
        if (!fieldName) {
            alert('Index field name cannot be empty.');
            return;
        }
        const isUnique = uniqueCheckbox.checked;
        await apiFetch(`/api/collections/${state.currentCollection}/indexes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fieldName: fieldName, unique: isUnique })
        });
        indexFieldInput.value = '';
        uniqueCheckbox.checked = false;
        loadCollectionData(); // Перезагрузить данные для отображения нового индекса
    }

    async function handleDeleteIndex(fieldName) {
        if (!confirm(`Are you sure you want to delete the index on field: "${fieldName}"?`)) return;
        await apiFetch(`/api/collections/${state.currentCollection}/indexes/${fieldName}`, { method: 'DELETE' });
        loadCollectionData(); // Перезагрузить
    }

    // --- Назначение обработчиков ---
    
    collectionSelect.addEventListener('change', handleSelectCollection);
    refreshBtn.addEventListener('click', loadInitialData);
    applyBtn.addEventListener('click', handleApplyFilters);
    prevBtn.addEventListener('click', () => { if(state.currentPage > 0) { state.currentPage--; loadCollectionData(); }});
    nextBtn.addEventListener('click', () => { state.currentPage++; loadCollectionData(); });
    createIndexBtn.addEventListener('click', handleCreateIndex);

    // --- Инициализация ---
    loadInitialData();
});