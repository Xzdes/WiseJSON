// explorer/views/script.js

const collectionSelect = document.getElementById('collectionSelect');
const loadBtn = document.getElementById('loadBtn');
const dataTable = document.getElementById('dataTable');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const filterName = document.getElementById('filterName');
const applyFilterBtn = document.getElementById('applyFilterBtn');
const pageSizeInput = document.getElementById('pageSizeInput');
const documentViewer = document.getElementById('documentViewer');

let currentCollection = '';
let currentPage = 0;
let pageSize = parseInt(pageSizeInput.value, 10);
let currentFilter = '';

pageSizeInput.addEventListener('change', () => {
    pageSize = parseInt(pageSizeInput.value, 10);
    currentPage = 0;
    renderDocuments();
});

async function fetchCollections() {
    const res = await fetch('/api/collections');
    const collections = await res.json();
    collectionSelect.innerHTML = '';
    collections.forEach(col => {
        const option = document.createElement('option');
        option.value = col.name;
        option.textContent = `${col.name} (${col.count})`;
        collectionSelect.appendChild(option);
    });
}

async function renderDocuments() {
    if (!currentCollection) return;
    const offset = currentPage * pageSize;
    let url = `/api/collections/${currentCollection}?limit=${pageSize}&offset=${offset}`;
    if (currentFilter) {
        url += `&filter_name=${encodeURIComponent(currentFilter)}`;
    }

    const res = await fetch(url);
    const docs = await res.json();

    const thead = dataTable.querySelector('thead');
    const tbody = dataTable.querySelector('tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    if (docs.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.textContent = 'No documents found.';
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }

    // Table header
    const headerRow = document.createElement('tr');
    Object.keys(docs[0]).forEach(key => {
        const th = document.createElement('th');
        th.textContent = key;
        headerRow.appendChild(th);
    });
    const viewTh = document.createElement('th');
    viewTh.textContent = 'View';
    headerRow.appendChild(viewTh);
    thead.appendChild(headerRow);

    // Table body
    docs.forEach(doc => {
        const row = document.createElement('tr');
        Object.values(doc).forEach(value => {
            const td = document.createElement('td');
            td.textContent = typeof value === 'object' ? JSON.stringify(value) : value;
            row.appendChild(td);
        });

        // Добавляем кнопку View
        const viewTd = document.createElement('td');
        const viewBtn = document.createElement('button');
        viewBtn.textContent = 'View';
        viewBtn.addEventListener('click', () => {
            documentViewer.value = JSON.stringify(doc, null, 2);
        });
        viewTd.appendChild(viewBtn);
        row.appendChild(viewTd);

        tbody.appendChild(row);
    });
}

loadBtn.addEventListener('click', () => {
    currentCollection = collectionSelect.value;
    currentPage = 0;
    currentFilter = '';
    renderDocuments();
});

prevBtn.addEventListener('click', () => {
    if (currentPage > 0) {
        currentPage--;
        renderDocuments();
    }
});

nextBtn.addEventListener('click', () => {
    currentPage++;
    renderDocuments();
});

applyFilterBtn.addEventListener('click', () => {
    currentFilter = filterName.value;
    currentPage = 0;
    renderDocuments();
});

window.addEventListener('load', fetchCollections);
