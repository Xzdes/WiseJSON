// explorer/seed.js
const path = require('path');
const fs = require('fs');
const WiseJSON = require('../wise-json/index.js'); // Путь от корня проекта

// Путь к директории БД в корне проекта
const DB_PATH = path.resolve(process.cwd(), 'wise-json-db-data');

// Демонстрационные данные
const sampleUsers = [
    { name: 'Alice', age: 30, city: 'New York', tags: ['dev', 'js'], active: true },
    { name: 'Bob', age: 25, city: 'London', tags: ['qa', 'python'], active: false },
    { name: 'Charlie', age: 35, city: 'New York', tags: ['dev', 'go'], active: true },
    { name: 'Diana', age: 30, city: 'Paris', tags: ['pm'], active: true },
    { name: 'Edward', age: 40, city: 'London', tags: ['devops', 'aws'], active: false, salary: 120000 },
    { name: 'Fiona', age: 28, city: 'Berlin', tags: ['design', 'css'], active: true },
    { name: 'George', age: 45, city: 'New York', tags: ['management'], active: true },
    { name: 'Hannah', age: 22, city: 'Paris', tags: ['intern', 'js'], active: true, expireAt: Date.now() + 60000 * 5 }, // Истечет через 5 минут
];

const sampleLogs = [
    { level: 'INFO', message: 'Application started.', timestamp: new Date(Date.now() - 60000 * 10).toISOString() },
    { level: 'WARN', message: 'DB connection is slow.', timestamp: new Date(Date.now() - 60000 * 8).toISOString() },
    { level: 'ERROR', message: 'Failed to fetch user data.', component: 'API', timestamp: new Date(Date.now() - 60000 * 5).toISOString() },
    { level: 'INFO', message: 'User Alice logged in.', userId: 'user_alice_id_placeholder', timestamp: new Date().toISOString() },
    { level: 'DEBUG', message: 'Temporary debug message.', ttl: 30000, timestamp: new Date().toISOString() }, // Истечет через 30 секунд
];

async function seedDatabase() {
    console.log(`Seeding database at: ${DB_PATH}`);

    // Очищаем старую директорию БД, если она есть
    if (fs.existsSync(DB_PATH)) {
        console.log('Removing old database directory...');
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
    
    // Инициализируем БД
    const db = new WiseJSON(DB_PATH);
    await db.init();

    try {
        // --- Коллекция Users ---
        console.log('\nCreating "users" collection...');
        const users = await db.collection('users');
        await users.initPromise;
        
        console.log('Inserting sample users...');
        await users.insertMany(sampleUsers);
        
        console.log('Creating indexes for "users"...');
        await users.createIndex('city'); // Стандартный индекс
        await users.createIndex('age');
        await users.createIndex('name', { unique: true }); // Уникальный индекс
        
        const userCount = await users.count();
        console.log(`✅ "users" collection created with ${userCount} documents and 3 indexes.`);

        // --- Коллекция Logs ---
        console.log('\nCreating "logs" collection...');
        const logs = await db.collection('logs');
        await logs.initPromise;

        console.log('Inserting sample logs...');
        await logs.insertMany(sampleLogs);

        console.log('Creating index for "logs"...');
        await logs.createIndex('level');

        const logCount = await logs.count();
        console.log(`✅ "logs" collection created with ${logCount} documents and 1 index.`);
        
    } catch (error) {
        console.error('\n🔥 An error occurred during seeding:', error);
    } finally {
        // Гарантированно закрываем БД, чтобы сохранить все изменения
        if (db) {
            console.log('\nClosing database connection...');
            await db.close();
        }
    }

    console.log('\nDatabase seeding complete! ✨');
    console.log('You can now run the server: node explorer/server.js');
}

seedDatabase();