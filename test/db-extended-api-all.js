// test/db-extended-api-all.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const WiseJSON = require('../wise-json/index.js');

const DB_PATH = path.resolve(__dirname, 'db-extended-api-all');
const COLLECTION_NAME = 'extended_api_tests';

function cleanUp() {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

// Вспомогательная функция для получения чистого объекта без мета-полей
function getCleanDoc(doc) {
    if (!doc) return null;
    const { _id, createdAt, updatedAt, ...rest } = doc;
    return rest;
}


async function main() {
    console.log('=== DB EXTENDED API TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    await db.init();
    const col = await db.collection(COLLECTION_NAME);
    await col.initPromise;

    // --- Подготовка данных ---
    const testData = [
        { name: 'Product A', category: 'books', price: 20, stock: 100, tags: ['fiction'] },
        { name: 'Product B', category: 'electronics', price: 200, stock: 50, tags: ['gadget', 'new'] },
        { name: 'Product C', category: 'books', price: 15, stock: 120, tags: ['non-fiction', 'history'] },
        { name: 'Product D', category: 'electronics', price: 150, stock: 75, tags: ['audio', 'new'] },
        { name: 'Product E', category: 'clothing', price: 50, stock: 200, tags: ['sale'] }
    ];
    await col.insertMany(testData);


    // --- Тест 1: updateOne ---
    console.log('  --- Testing updateOne ---');
    let updateResult = await col.updateOne(
        { name: 'Product A' },
        { $set: { price: 25, status: 'reviewed' }, $inc: { stock: -5 } }
    );
    assert.deepStrictEqual(updateResult, { matchedCount: 1, modifiedCount: 1 }, 'updateOne should match and modify 1 doc');
    
    let productA = await col.findOne({ name: 'Product A' });
    assert.strictEqual(productA.price, 25, 'updateOne: price should be updated via $set');
    assert.strictEqual(productA.stock, 95, 'updateOne: stock should be decremented via $inc');
    assert.strictEqual(productA.status, 'reviewed', 'updateOne: new field should be added via $set');
    console.log('  --- updateOne PASSED ---');


    // --- Тест 2: updateMany ---
    console.log('  --- Testing updateMany ---');
    updateResult = await col.updateMany(
        { category: 'electronics' },
        { $set: { on_sale: true }, $inc: { price: -10 } }
    );
    assert.deepStrictEqual(updateResult, { matchedCount: 2, modifiedCount: 2 }, 'updateMany should match and modify 2 docs');

    const electronics = await col.find({ category: 'electronics' });
    assert.ok(electronics.every(d => d.on_sale === true), 'updateMany: all electronics should be on sale');
    assert.strictEqual(electronics.find(d=>d.name==='Product B').price, 190, 'updateMany: Product B price should be 190');
    assert.strictEqual(electronics.find(d=>d.name==='Product D').price, 140, 'updateMany: Product D price should be 140');
    console.log('  --- updateMany PASSED ---');


    // --- Тест 3: deleteOne и deleteMany ---
    console.log('  --- Testing deleteOne and deleteMany ---');
    let deleteResult = await col.deleteOne({ name: 'Product E' });
    assert.deepStrictEqual(deleteResult, { deletedCount: 1 }, 'deleteOne should delete 1 doc');
    assert.strictEqual(await col.count(), 4, 'Count should be 4 after deleteOne');

    deleteResult = await col.deleteMany({ category: 'books' });
    assert.deepStrictEqual(deleteResult, { deletedCount: 2 }, 'deleteMany should delete 2 docs');
    assert.strictEqual(await col.count(), 2, 'Count should be 2 after deleteMany');
    console.log('  --- deleteOne and deleteMany PASSED ---');


    // --- Тест 4: findOneAndUpdate ---
    console.log('  --- Testing findOneAndUpdate ---');
    // По умолчанию возвращает новый документ
    let fnuResult = await col.findOneAndUpdate(
        { name: 'Product B' },
        { $inc: { stock: 10 } }
    );
    assert.strictEqual(fnuResult.stock, 60, 'findOneAndUpdate should return updated doc by default');

    // С опцией returnOriginal: true возвращает старый
    fnuResult = await col.findOneAndUpdate(
        { name: 'Product D' },
        { $set: { stock: 0 } },
        { returnOriginal: true }
    );
    assert.strictEqual(fnuResult.stock, 75, 'findOneAndUpdate with returnOriginal should return original doc');
    const productDAfter = await col.findOne({ name: 'Product D' });
    assert.strictEqual(productDAfter.stock, 0, 'Document D should be updated in DB after findOneAndUpdate');
    console.log('  --- findOneAndUpdate PASSED ---');


    // --- Тест 5: Проекции ---
    console.log('  --- Testing projections ---');
    // Включение полей
    let projectedDocs = await col.find({ category: 'electronics' }, { name: 1, price: 1 });
    assert.strictEqual(Object.keys(projectedDocs[0]).length, 3, 'Inclusion projection should have 3 keys (_id, name, price)');
    assert.deepStrictEqual(getCleanDoc(projectedDocs[0]), { name: 'Product B', price: 190 }, 'Inclusion projection result is incorrect');
    
    // Включение полей с исключением _id
    projectedDocs = await col.find({ category: 'electronics' }, { name: 1, price: 1, _id: 0 });
    assert.strictEqual(Object.keys(projectedDocs[0]).length, 2, 'Inclusion projection with _id:0 should have 2 keys');
    assert.deepStrictEqual(projectedDocs[0], { name: 'Product B', price: 190 }, 'Inclusion projection with _id:0 result is incorrect');

    // Исключение полей
    const fullDoc = await col.findOne({ name: 'Product B' });
    const exclusionResult = await col.findOne({ name: 'Product B' }, { tags: 0, on_sale: 0 });
    assert.ok(!exclusionResult.hasOwnProperty('tags'), 'Exclusion projection should not have "tags" field');
    assert.ok(!exclusionResult.hasOwnProperty('on_sale'), 'Exclusion projection should not have "on_sale" field');
    assert.ok(exclusionResult.hasOwnProperty('price'), 'Exclusion projection should have "price" field');
    console.log('  --- projections PASSED ---');


    await db.close();
    cleanUp();

    console.log('=== DB EXTENDED API TEST PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Тестовая директория не была удалена для отладки: ${DB_PATH}`);
    process.exit(1);
});