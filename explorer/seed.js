// explorer/seed.js
const path = require('path');
const fs = require('fs');
const WiseJSON = require('../wise-json/index.js');

// --- Конфигурация ---
const DB_PATH = path.resolve(process.cwd(), 'wise-json-db-data');
const USER_COUNT = 150;
const ORDER_COUNT = 400;
const LOG_COUNT = 1000;

// --- Вспомогательные данные для генерации ---
const FIRST_NAMES = ['Иван', 'Петр', 'Алиса', 'Елена', 'Дмитрий', 'Мария', 'Сергей', 'Анна'];
const LAST_NAMES = ['Иванов', 'Петров', 'Смирнова', 'Попова', 'Волков', 'Кузнецова', 'Зайцев'];
const CITIES = ['Москва', 'Санкт-Петербург', 'Новосибирск', 'Екатеринбург', 'Казань', 'Лондон'];
const TAGS = ['dev', 'qa', 'pm', 'design', 'js', 'python', 'go', 'devops', 'vip'];
const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
const LOG_COMPONENTS = ['API', 'WebApp', 'PaymentGateway', 'AuthService'];
const ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];
const PRODUCTS = [
    { name: 'Ноутбук Pro', price: 120000 },
    { name: 'Смартфон X', price: 80000 },
    { name: 'Беспроводные наушники', price: 15000 },
    { name: 'Умные часы', price: 25000 }
];

// --- Вспомогательные функции ---
const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// --- Основной скрипт ---
async function seedDatabase() {
    console.log(`\n🌱 Запускаем наполнение базы данных в: ${DB_PATH}`);

    if (fs.existsSync(DB_PATH)) {
        console.log('   - Удаляем старую директорию базы данных...');
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
    
    const db = new WiseJSON(DB_PATH);
    await db.init();
    console.log('   - База данных инициализирована.');

    try {
        // --- 1. Коллекция Users ---
        console.log(`\n👤 Генерируем и вставляем ${USER_COUNT} пользователей...`);
        const usersCollection = await db.getCollection('users');
        await usersCollection.initPromise;

        const users = [];
        for (let i = 0; i < USER_COUNT; i++) {
            const user = {
                _id: `user_${i}`,
                name: `${getRandom(FIRST_NAMES)} ${getRandom(LAST_NAMES)}`,
                email: `user${i}@example.com`,
                age: getRandomInt(18, 65),
                city: getRandom(CITIES),
                tags: [getRandom(TAGS), getRandom(TAGS)].filter((v, i, a) => a.indexOf(v) === i), // 1-2 уникальных тега
                active: Math.random() > 0.2, // 80% активных
            };
            if (i % 10 === 0) { // Каждый 10-й пользователь имеет менеджера
                user.managerId = `user_${getRandomInt(0, USER_COUNT - 1)}`;
            }
            if (i % 25 === 0) { // Каждый 25-й истечет через час
                user.expireAt = Date.now() + 3600 * 1000;
            }
            users.push(user);
        }
        await usersCollection.insertMany(users);
        
        console.log('   - Создаем индексы для "users"...');
        await usersCollection.createIndex('city');
        await usersCollection.createIndex('age');
        await usersCollection.createIndex('email', { unique: true });
        console.log(`✅ Коллекция "users" создана с ${await usersCollection.count()} документами.`);

        // --- 2. Коллекция Orders ---
        console.log(`\n🛒 Генерируем и вставляем ${ORDER_COUNT} заказов...`);
        const ordersCollection = await db.getCollection('orders');
        await ordersCollection.initPromise;
        
        const orders = [];
        for (let i = 0; i < ORDER_COUNT; i++) {
            const productCount = getRandomInt(1, 3);
            const orderProducts = Array.from({ length: productCount }, () => getRandom(PRODUCTS));
            orders.push({
                userId: `user_${getRandomInt(0, USER_COUNT - 1)}`,
                status: getRandom(ORDER_STATUSES),
                products: orderProducts,
                totalAmount: orderProducts.reduce((sum, p) => sum + p.price, 0),
                createdAt: new Date(Date.now() - getRandomInt(0, 30) * 86400000).toISOString(), // за последний месяц
            });
        }
        await ordersCollection.insertMany(orders);

        console.log('   - Создаем индексы для "orders"...');
        await ordersCollection.createIndex('userId');
        await ordersCollection.createIndex('status');
        console.log(`✅ Коллекция "orders" создана с ${await ordersCollection.count()} документами.`);

        // --- 3. Коллекция Logs ---
        console.log(`\n📄 Генерируем и вставляем ${LOG_COUNT} логов...`);
        const logsCollection = await db.getCollection('logs');
        await logsCollection.initPromise;

        const logs = [];
        for (let i = 0; i < LOG_COUNT; i++) {
            const log = {
                level: getRandom(LOG_LEVELS),
                component: getRandom(LOG_COMPONENTS),
                message: `Operation ${i} completed with status code ${getRandomInt(200, 500)}.`,
                timestamp: new Date(Date.now() - getRandomInt(0, 24 * 60) * 60000).toISOString(), // за последние сутки
            };
            if (log.level === 'DEBUG') { // Debug-логи живут 5 минут
                log.ttl = 5 * 60 * 1000;
            }
            if (i % 5 === 0) { // Привязываем некоторые логи к пользователям
                log.userId = `user_${getRandomInt(0, USER_COUNT - 1)}`;
            }
            logs.push(log);
        }
        await logsCollection.insertMany(logs);

        console.log('   - Создаем индекс для "logs"...');
        await logsCollection.createIndex('level');
        console.log(`✅ Коллекция "logs" создана с ${await logsCollection.count()} документами.`);

    } catch (error) {
        console.error('\n🔥 Произошла ошибка во время наполнения базы данных:', error);
    } finally {
        if (db) {
            console.log('\n- Завершаем соединение с базой данных, сохраняя все изменения...');
            await db.close();
        }
    }

    console.log('\n✨ Наполнение базы данных завершено! ✨');
    console.log('Теперь вы можете запустить сервер: node explorer/server.js');
}

seedDatabase();