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
        totalDocs: 0, 
        filter: {},
        sort: { field: '_id', order: 'asc' },
        writeMode: false,
    };

    // --- DOM элементы ---
    const toastNotifications = document.getElementById('toastNotifications');
    const dbMap = document.getElementById('dbMap');
    const collectionSelect = document.getElementById('collectionSelect');
    const queryBuilder = document.getElementById('queryBuilder');
    const refreshBtn = document.getElementById('refreshBtn');
    const applyBtn = document.getElementById('applyBtn');
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

    // --- Утилитарная функция для уведомлений ---
    function showToast(message, type = 'info') {
        // "Лениво" получаем элемент в момент вызова
        const toastElement = document.getElementById('toastNotifications');
        if (toastElement && typeof toastElement.show === 'function') {
            toastElement.show(message, type);
        } else {
            // Фоллбэк, если компонент еще не готов
            console.warn('Toast component not ready, falling back to alert.', { message, type });
            alert(`${type.toUpperCase()}: ${message}`);
        }
    }

    // --- API Функции ---
    async function apiFetch(url, options = {}) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) {
                return response.json();
            }
            return {};
        } catch (error) {
            showToast(error.message, 'error');
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
        
        const fieldsForBuilder = Array.from(headers).filter(h => h !== '_actions');
        queryBuilder.setFields(fieldsForBuilder);

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
                documentViewer.value = doc; 
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
                         documentViewer.value = doc;
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
        nextBtn.disabled = state.documents.length < state.pageSize;
    }
    
    function updateWriteModeUI() {
        document.querySelectorAll('.write-op').forEach(el => {
            el.style.display = state.writeMode ? 'flex' : 'none';
        });
        if (state.writeMode) {
            serverModeEl.textContent = 'Server Mode: Write-Enabled';
            serverModeEl.className = 'server-mode-write-enabled';
        }
    }

    // --- Логика обработчиков событий ---
    async function loadInitialData() {
        try {
            const [collectionsData, graphData, permissions] = await Promise.all([
                apiFetch('/api/collections'),
                apiFetch('/api/schema-graph'),
                apiFetch('/api/permissions')
            ]);
            
            state.collections = collectionsData;
            dbMap.render(graphData);
            renderCollections();

            state.writeMode = permissions.writeMode;
            updateWriteModeUI();
        } catch (e) { 
            // Ошибки уже обработаны и показаны в apiFetch
        }
    }

    async function loadCollectionData(collectionName) {
        state.currentCollection = collectionName;
        collectionSelect.value = collectionName;

        if (!state.currentCollection) {
            state.documents = [];
            state.indexes = [];
            renderDocuments();
            renderIndexes();
            queryBuilder.setFields([]);
            return;
        };
        
        const offset = state.currentPage * state.pageSize;
        const query = new URLSearchParams({
            limit: state.pageSize,
            offset: offset,
            sort: state.sort.field,
            order: state.sort.order,
            filter: JSON.stringify(state.filter)
        });
        
        const [docs, statsData] = await Promise.all([
            apiFetch(`/api/collections/${state.currentCollection}?${query}`),
            apiFetch(`/api/collections/${state.currentCollection}/stats`)
        ]);

        state.documents = docs;
        state.indexes = statsData.indexes || [];
        
        renderDocuments();
        renderIndexes();
        renderPagination();
    }
    
    function handleSelectCollection() {
        state.currentPage = 0;
        const selectedName = collectionSelect.value;
        loadCollectionData(selectedName);
    }
    
    function handleMapSelection(event) {
        state.currentPage = 0;
        const { collectionName } = event.detail;
        loadCollectionData(collectionName);
    }

    function handleFilterChange(event) {
        state.filter = event.detail.filter;
    }

    function handleApplyFilters() {
        if (!state.currentCollection) {
            showToast('Please select a collection first.', 'error');
            return;
        }
        state.currentPage = 0;
        state.sort.field = sortInput.value || '_id';
        state.sort.order = orderSelect.value;
        state.pageSize = parseInt(pageSizeInput.value, 10) || 10;
        loadCollectionData(state.currentCollection);
    }
    
    async function handleDeleteDocument(docId) {
        if (!confirm(`Are you sure you want to delete document with ID: ${docId}?`)) return;
        await apiFetch(`/api/collections/${state.currentCollection}/doc/${docId}`, { method: 'DELETE' });
        showToast(`Document ${docId.substring(0, 8)}... removed.`, 'success');
        await loadCollectionData(state.currentCollection);
    }
    
    async function handleCreateIndex() {
        if (!state.currentCollection) {
            showToast('Please select a collection first to create an index.', 'error');
            return;
        }
        const fieldName = indexFieldInput.value.trim();
        if (!fieldName) {
            showToast('Index field name cannot be empty.', 'error');
            return;
        }
        const isUnique = uniqueCheckbox.checked;
        await apiFetch(`/api/collections/${state.currentCollection}/indexes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fieldName: fieldName, unique: isUnique })
        });
        showToast(`Index on "${fieldName}" created.`, 'success');
        indexFieldInput.value = '';
        uniqueCheckbox.checked = false;
        await loadCollectionData(state.currentCollection);
    }

    async function handleDeleteIndex(fieldName) {
        if (!confirm(`Are you sure you want to delete the index on field: "${fieldName}"?`)) return;
        await apiFetch(`/api/collections/${state.currentCollection}/indexes/${fieldName}`, { method: 'DELETE' });
        showToast(`Index on "${fieldName}" dropped.`, 'success');
        await loadCollectionData(state.currentCollection);
    }
    
    function handlePrevPage() {
        if (state.currentPage > 0) {
            state.currentPage--;
            loadCollectionData(state.currentCollection);
        }
    }
    
    function handleNextPage() {
        state.currentPage++;
        loadCollectionData(state.currentCollection);
    }

    // --- Назначение обработчиков ---
    dbMap.addEventListener('collection-selected', handleMapSelection);
    queryBuilder.addEventListener('filter-changed', handleFilterChange);
    collectionSelect.addEventListener('change', handleSelectCollection);
    refreshBtn.addEventListener('click', loadInitialData);
    applyBtn.addEventListener('click', handleApplyFilters);
    prevBtn.addEventListener('click', handlePrevPage);
    nextBtn.addEventListener('click', handleNextPage);
    createIndexBtn.addEventListener('click', handleCreateIndex);

    // --- Инициализация ---
    loadInitialData();
});