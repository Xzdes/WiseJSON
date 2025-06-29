// explorer/views/components/query-builder.js

class QueryBuilderComponent extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.rules = [];
        this.fields = [];
        this.logicalOperator = 'AND'; // Логика по умолчанию
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    padding: 10px;
                    border: 1px solid #d1d5da;
                    border-radius: 6px;
                    background-color: #f6f8fa;
                }
                .rules-container {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .rule {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr auto;
                    gap: 8px;
                    align-items: center;
                }
                select, input {
                    width: 100%;
                    padding: 6px 10px;
                    border: 1px solid #d1d5da;
                    border-radius: 6px;
                    font-size: 13px;
                    box-sizing: border-box;
                }
                .remove-btn {
                    padding: 4px 8px;
                    background-color: #d73a49;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-weight: bold;
                }
                .actions {
                    margin-top: 10px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .add-btn {
                    padding: 6px 12px;
                    background-color: #2ea44f;
                    color: white;
                    border: 1px solid rgba(27,31,35,.15);
                    border-radius: 6px;
                    cursor: pointer;
                }
            </style>
            <div class="rules-container" id="rules-container">
                <!-- Правила фильтрации будут добавлены сюда -->
            </div>
            <div class="actions">
                <button class="add-btn" id="add-rule-btn">Add Filter Rule</button>
                <!-- Здесь можно будет добавить переключатель AND/OR -->
            </div>
        `;

        this._rulesContainer = this.shadowRoot.getElementById('rules-container');
        this.shadowRoot.getElementById('add-rule-btn').addEventListener('click', () => this.addRule());
    }

    /**
     * Публичный метод для заполнения списка полей, доступных для фильтрации.
     * @param {Array<string>} fields - Массив имен полей.
     */
    setFields(fields = []) {
        this.fields = fields;
        // Если правил еще нет, добавляем первое пустое правило
        if (this.rules.length === 0) {
            this.addRule();
        } else {
            // Иначе перерисовываем существующие с новым списком полей
            this.render();
        }
    }

    addRule(ruleData = { field: '', op: '$eq', value: '' }) {
        this.rules.push(ruleData);
        this.render();
    }

    removeRule(index) {
        this.rules.splice(index, 1);
        this.render();
        this._emitFilterChange(); // Отправляем событие после удаления
    }

    render() {
        this._rulesContainer.innerHTML = '';
        this.rules.forEach((rule, index) => {
            const ruleEl = this._createRuleElement(rule, index);
            this._rulesContainer.appendChild(ruleEl);
        });
    }

    _createRuleElement(rule, index) {
        const div = document.createElement('div');
        div.className = 'rule';

        // 1. Выпадающий список полей
        const fieldOptions = this.fields.map(f => `<option value="${f}" ${rule.field === f ? 'selected' : ''}>${f}</option>`).join('');
        const fieldSelect = document.createElement('select');
        fieldSelect.innerHTML = `<option value="">-- Select Field --</option>${fieldOptions}`;
        fieldSelect.dataset.index = index;
        fieldSelect.dataset.type = 'field';
        fieldSelect.value = rule.field;

        // 2. Выпадающий список операторов
        const operators = {
            '$eq': '=',
            '$ne': '!=',
            '$gt': '>',
            '$gte': '>=',
            '$lt': '<',
            '$lte': '<=',
            '$in': 'in (comma sep.)',
            '$regex': 'matches (regex)',
            '$exists': 'exists'
        };
        const opOptions = Object.entries(operators).map(([key, val]) => `<option value="${key}" ${rule.op === key ? 'selected' : ''}>${val}</option>`).join('');
        const opSelect = document.createElement('select');
        opSelect.innerHTML = opOptions;
        opSelect.dataset.index = index;
        opSelect.dataset.type = 'op';
        opSelect.value = rule.op;

        // 3. Поле для ввода значения
        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.placeholder = 'Value';
        valueInput.dataset.index = index;
        valueInput.dataset.type = 'value';
        valueInput.value = rule.value;
        if (rule.op === '$exists') {
            valueInput.placeholder = 'true / false';
        }

        // 4. Кнопка удаления правила
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '−';
        removeBtn.title = 'Remove this rule';
        removeBtn.addEventListener('click', () => this.removeRule(index));

        div.appendChild(fieldSelect);
        div.appendChild(opSelect);
        div.appendChild(valueInput);
        div.appendChild(removeBtn);

        // Вешаем слушателей на изменения
        fieldSelect.addEventListener('change', (e) => this._handleRuleChange(e));
        opSelect.addEventListener('change', (e) => this._handleRuleChange(e));
        valueInput.addEventListener('input', (e) => this._handleRuleChange(e));

        return div;
    }

    _handleRuleChange(event) {
        const { index, type } = event.target.dataset;
        const value = event.target.value;
        this.rules[index][type] = value;
        // Перерисовываем, если нужно изменить плейсхолдер
        if(type === 'op') this.render();
        this._emitFilterChange();
    }

    _emitFilterChange() {
        const filter = {};
        const validRules = this.rules.filter(r => r.field);
        
        if (validRules.length === 0) {
            this.dispatchEvent(new CustomEvent('filter-changed', { detail: { filter: {} } }));
            return;
        }

        const conditions = validRules.map(rule => {
            let value = rule.value;
            // Преобразование типов
            if (rule.op === '$exists') {
                value = value.toLowerCase() === 'true';
            } else if (rule.op === '$in') {
                value = value.split(',').map(s => s.trim()).filter(Boolean);
            } else if (value.trim() !== '' && !isNaN(Number(value))) {
                value = Number(value);
            }
            
            if (rule.op === '$eq') {
                return { [rule.field]: value };
            }
            return { [rule.field]: { [rule.op]: value } };
        });

        if (conditions.length > 1) {
            // Для AND-логики
            Object.assign(filter, ...conditions.map(cond => ({...cond})));
        } else if (conditions.length === 1) {
            Object.assign(filter, conditions[0]);
        }

        this.dispatchEvent(new CustomEvent('filter-changed', {
            bubbles: true,
            composed: true,
            detail: { filter }
        }));
    }
}

customElements.define('query-builder', QueryBuilderComponent);