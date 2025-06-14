// wise-json/collection/query-ops.js

const { cleanupExpiredDocs, isAlive } = require('./ttl.js');
const { matchFilter } = require('./utils.js');
const logger = require('../logger');

// --- Вспомогательные функции для операций обновления ---

function applyUpdateOperators(doc, updateQuery) {
    let newDoc = { ...doc };
    let hasOperators = false;
    for (const op in updateQuery) {
        if (op.startsWith('$')) {
            hasOperators = true;
            break;
        }
    }

    if (!hasOperators) {
        // Полная замена документа (кроме _id и createdAt)
        const _id = newDoc._id;
        const createdAt = newDoc.createdAt;
        newDoc = { ...updateQuery, _id, createdAt };
        return newDoc;
    }

    for (const op in updateQuery) {
        const opArgs = updateQuery[op];
        switch (op) {
            case '$set':
                Object.assign(newDoc, opArgs);
                break;
            case '$inc':
                for (const field in opArgs) {
                    newDoc[field] = (newDoc[field] || 0) + opArgs[field];
                }
                break;
            case '$unset':
                for (const field in opArgs) {
                    delete newDoc[field];
                }
                break;
            case '$push':
                for (const field in opArgs) {
                    if (!Array.isArray(newDoc[field])) newDoc[field] = [];
                    if (opArgs[field] && opArgs[field].$each) {
                        newDoc[field].push(...opArgs[field].$each);
                    } else {
                        newDoc[field].push(opArgs[field]);
                    }
                }
                break;
            case '$pull':
                 for (const field in opArgs) {
                    if (Array.isArray(newDoc[field])) {
                       newDoc[field] = newDoc[field].filter(item => item !== opArgs[field]);
                    }
                }
                break;
        }
    }
    return newDoc;
}

function applyProjection(doc, projection) {
    if (!projection || Object.keys(projection).length === 0) {
        return doc;
    }

    const newDoc = {};
    const hasInclusion = Object.values(projection).some(v => v === 1);
    const hasExclusion = Object.values(projection).some(v => v === 0);

    if (hasInclusion && hasExclusion && !projection.hasOwnProperty('_id')) {
        throw new Error('Projection cannot have a mix of inclusion and exclusion.');
    }
    
    if (hasInclusion) {
        for (const key in projection) {
            if (projection[key] === 1 && doc.hasOwnProperty(key)) {
                newDoc[key] = doc[key];
            }
        }
        if (projection._id !== 0) {
            newDoc._id = doc._id;
        }
    } else { // Режим исключения
        const excludedKeys = new Set(Object.keys(projection).filter(k => projection[k] === 0));
        for (const key in doc) {
            if (!excludedKeys.has(key)) {
                newDoc[key] = doc[key];
            }
        }
    }

    return newDoc;
}


// --- Основные методы API ---

async function getById(id) {
    const doc = this.documents.get(id);
    return doc && isAlive(doc) ? doc : null;
}

async function getAll() {
    cleanupExpiredDocs(this.documents, this._indexManager);
    return Array.from(this.documents.values());
}

async function count(query) {
    cleanupExpiredDocs(this.documents, this._indexManager);
    if (!query || Object.keys(query).length === 0) {
        return this.documents.size;
    }
    const results = await this.find(query);
    return results.length;
}

async function find(query, projection = {}) {
    if (typeof query === 'function') { // Обратная совместимость
        cleanupExpiredDocs(this.documents, this._indexManager);
        const docs = Array.from(this.documents.values()).filter(doc => isAlive(doc)).filter(query);
        return docs.map(doc => applyProjection(doc, projection));
    }

    if (typeof query === 'object' && query !== null) {
        cleanupExpiredDocs(this.documents, this._indexManager);
        
        let initialDocIds = null;
        let bestIndexField = null;

        for (const fieldName in query) {
            const condition = query[fieldName];
            if (this._indexManager.indexes.has(fieldName)) {
                if (typeof condition !== 'object') {
                    bestIndexField = { field: fieldName, type: 'exact' };
                    break;
                }
                if (typeof condition === 'object' && Object.keys(condition).some(op => ['$gt', '$gte', '$lt', '$lte'].includes(op))) {
                    if (!bestIndexField) {
                        bestIndexField = { field: fieldName, type: 'range' };
                    }
                }
            }
        }

        if (bestIndexField) {
            initialDocIds = new Set();
            const index = this._indexManager.indexes.get(bestIndexField.field);
            const condition = query[bestIndexField.field];
            
            if (bestIndexField.type === 'exact') {
                const ids = index.type === 'unique' 
                    ? [this._indexManager.findOneIdByIndex(bestIndexField.field, condition)].filter(Boolean)
                    : this._indexManager.findIdsByIndex(bestIndexField.field, condition);
                ids.forEach(id => initialDocIds.add(id));
            } else if (bestIndexField.type === 'range') {
                for (const [indexedValue, idsOrId] of index.data.entries()) {
                    const pseudoDoc = { [bestIndexField.field]: indexedValue };
                    if (matchFilter(pseudoDoc, { [bestIndexField.field]: condition })) {
                        if (index.type === 'unique') initialDocIds.add(idsOrId);
                        else idsOrId.forEach(id => initialDocIds.add(id));
                    }
                }
            }
        }

        const results = [];
        const source = initialDocIds !== null
          ? Array.from(initialDocIds).map(id => this.documents.get(id)).filter(Boolean)
          : this.documents.values();

        for (const doc of source) {
          if (isAlive(doc) && matchFilter(doc, query)) {
            results.push(applyProjection(doc, projection));
          }
        }
        return results;
    }

    throw new Error('find: query must be a function or a filter object.');
}

async function findOne(query, projection = {}) {
    if (typeof query === 'function') { // Обратная совместимость
        cleanupExpiredDocs(this.documents, this._indexManager);
        for (const doc of this.documents.values()) {
            if (isAlive(doc) && query(doc)) {
                return applyProjection(doc, projection);
            }
        }
        return null;
    }

    if (typeof query === 'object' && query !== null) {
        const results = await this.find(query, projection);
        return results.length > 0 ? results[0] : null;
    }

    throw new Error('findOne: query must be a function or a filter object.');
}

async function updateOne(filter, updateQuery) {
    const docToUpdate = await this.findOne(filter);
    if (!docToUpdate) {
        return { matchedCount: 0, modifiedCount: 0 };
    }
    
    const newDocData = applyUpdateOperators(docToUpdate, updateQuery);
    
    const updatedDoc = await this.update(docToUpdate._id, newDocData);
    
    return { matchedCount: 1, modifiedCount: updatedDoc ? 1 : 0 };
}

async function updateMany(filter, updateQuery) {
    // ВАЖНО: `updateMany` из ops.js вызывает `this.update` для каждого документа.
    // Нам нужно, чтобы `update` мог принимать не только полную замену, но и операторы.
    // Поэтому мы делегируем логику нашему внутреннему `updateOne`, который знает про операторы.
    const docsToUpdate = await this.find(filter);
    if (docsToUpdate.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    let modifiedCount = 0;
    for (const doc of docsToUpdate) {
        // Мы не можем просто вызвать updateMany из ops.js, так как он не знает про операторы.
        // Поэтому мы итерируем здесь и обновляем по одному.
        const result = await this.updateOne({ _id: doc._id }, updateQuery);
        if (result.modifiedCount > 0) {
            modifiedCount++;
        }
    }

    return { matchedCount: docsToUpdate.length, modifiedCount };
}


async function findOneAndUpdate(filter, updateQuery, options = {}) {
    const { returnOriginal = false } = options;
    const docToUpdate = await this.findOne(filter);
    if (!docToUpdate) return null;
    
    // Здесь мы не используем this.update, а напрямую вызываем _enqueueDataModification
    // чтобы получить и старый, и новый документ в одной атомарной операции.
    // Но для простоты пока оставим вызов this.update
    const newDocData = applyUpdateOperators(docToUpdate, updateQuery);
    const updatedDoc = await this.update(docToUpdate._id, newDocData);

    return returnOriginal ? docToUpdate : updatedDoc;
}

async function deleteOne(filter) {
    const docToRemove = await this.findOne(filter);
    if (!docToRemove) {
        return { deletedCount: 0 };
    }
    const success = await this.remove(docToRemove._id);
    return { deletedCount: success ? 1 : 0 };
}

async function deleteMany(filter) {
    const docsToRemove = await this.find(filter);
    const idsToRemove = docsToRemove.map(d => d._id);
    if (idsToRemove.length === 0) {
        return { deletedCount: 0 };
    }

    // Используем removeMany из ops.js, который итерирует и удаляет по одному
    const deletedCount = await this.removeMany(doc => idsToRemove.includes(doc._id));
    return { deletedCount };
}


// --- СТАРЫЕ МЕТОДЫ ДЛЯ ОБРАТНОЙ СОВМЕСТИМОСТИ ---

async function findByIndexedValue(fieldName, value) {
  cleanupExpiredDocs(this.documents, this._indexManager);
  
  const index = this._indexManager.indexes.get(fieldName);
  if (!index) {
    return [];
  }

  let idsToFetch = new Set();
  if (index.type === 'unique') {
    const id = this._indexManager.findOneIdByIndex(fieldName, value);
    if (id) {
      idsToFetch.add(id);
    }
  } else {
    idsToFetch = this._indexManager.findIdsByIndex(fieldName, value);
  }

  const result = [];
  for (const id of idsToFetch) {
    const doc = this.documents.get(id);
    if (doc && isAlive(doc)) {
      result.push(doc);
    }
  }
  return result;
}

async function findOneByIndexedValue(fieldName, value) {
  const index = this._indexManager.indexes.get(fieldName);
  if (!index) {
    return null;
  }
  
  let doc = null;
  if (index.type === 'unique') {
    const id = this._indexManager.findOneIdByIndex(fieldName, value);
    if (id) {
      const potentialDoc = this.documents.get(id);
      if (potentialDoc && isAlive(potentialDoc)) {
        doc = potentialDoc;
      }
    }
  } else {
    const results = await this.findByIndexedValue(fieldName, value);
    if (results.length > 0) {
      doc = results[0];
    }
  }
  return doc;
}

module.exports = {
  // Основные
  getById,
  getAll,
  count,
  find,
  findOne,

  // Расширенные (в стиле MongoDB)
  updateOne,
  updateMany,
  findOneAndUpdate,
  deleteOne,
  deleteMany,

  // Старые методы для обратной совместимости
  findByIndexedValue,
  findOneByIndexedValue,
};