const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

let app = null;
try {
    const electron = require('electron');
    app = electron ? electron.app : null;
} catch (e) {
    app = null;
}

let db = null;

// Determine writable SQLite DB path (development vs packaged production)
function getDbPath() {
    if (app && app.isPackaged) {
        const userDataPath = app.getPath('userData');
        const dbFile = path.join(userDataPath, 'esms.db');
        if (!fs.existsSync(dbFile)) {
            const bundledDb = path.join(process.resourcesPath || '', 'esms.db');
            if (fs.existsSync(bundledDb)) {
                try {
                    fs.copyFileSync(bundledDb, dbFile);
                    console.log('Copied bundled esms.db to userData:', dbFile);
                } catch (e) {
                    console.error('Could not copy bundled DB:', e.message);
                }
            }
        }
        return dbFile;
    }
    return path.join(__dirname, 'esms.db');
}

// Promise-based query helpers
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Database not initialized'));
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Database not initialized'));
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
    });
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Database not initialized'));
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({
            lastID: this.lastID,
            insertId: this.lastID,
            changes: this.changes,
            affectedRows: this.changes
        });
    });
});

// Transaction helper
async function withTransaction(callback) {
    if (!db) throw new Error('Database not initialized');
    await dbRun('BEGIN TRANSACTION');
    try {
        const tx = {
            dbGet,
            dbAll,
            dbRun
        };
        const result = await callback(tx);
        await dbRun('COMMIT');
        return result;
    } catch (error) {
        try {
            await dbRun('ROLLBACK');
        } catch (_) { }
        throw error;
    }
}

// Database initialization
async function initializeDatabase() {
    if (db) return db;

    const dbPath = getDbPath();
    console.log('Connecting to SQLite database at:', dbPath);

    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(dbPath, async (err) => {
            if (err) {
                console.error('Error opening SQLite database:', err.message);
                reject(err);
            } else {
                try {
                    await dbRun('PRAGMA foreign_keys = ON');
                    await createTables();
                    console.log('✓ SQLite database initialized successfully at:', dbPath);
                    resolve(db);
                } catch (error) {
                    console.error('Database initialization error:', error);
                    reject(error);
                }
            }
        });
    });
}

// Schema creation & migrations
async function createTables() {
    // 1. Admin Table
    await dbRun(`CREATE TABLE IF NOT EXISTS admin (
        admin_id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        profile_image TEXT,
        recovery_code TEXT
    )`);

    const adminCols = await dbAll("PRAGMA table_info(admin)");
    if (!adminCols.some(c => c.name === 'profile_image')) {
        await dbRun("ALTER TABLE admin ADD COLUMN profile_image TEXT");
    }
    if (!adminCols.some(c => c.name === 'recovery_code')) {
        await dbRun("ALTER TABLE admin ADD COLUMN recovery_code TEXT");
        const defaultRecoveryCode = hashPassword('123456');
        await dbRun("UPDATE admin SET recovery_code = ? WHERE recovery_code IS NULL", [defaultRecoveryCode]);
    }

    const admin = await dbGet('SELECT * FROM admin WHERE username = ?', ['admin']);
    if (!admin) {
        const hashedPassword = hashPassword('admin123');
        const hashedRecoveryCode = hashPassword('123456');
        await dbRun('INSERT INTO admin (username, password, recovery_code) VALUES (?, ?, ?)',
            ['admin', hashedPassword, hashedRecoveryCode]);
        console.log('✓ Default admin created');
    }

    // 2. Products Table
    await dbRun(`CREATE TABLE IF NOT EXISTS products (
        product_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT,
        brand TEXT,
        purchase_price REAL NOT NULL,
        selling_price REAL NOT NULL,
        stock_qty INTEGER DEFAULT 0,
        min_stock_level INTEGER DEFAULT 5,
        supplier_name TEXT,
        warranty_period TEXT,
        date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const productCols = await dbAll("PRAGMA table_info(products)");
    if (!productCols.some(c => c.name === 'last_updated')) {
        await dbRun("ALTER TABLE products ADD COLUMN last_updated DATETIME DEFAULT CURRENT_TIMESTAMP");
    }

    // 3. Customers Table
    await dbRun(`CREATE TABLE IF NOT EXISTS customers (
        customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT,
        id_number TEXT,
        email TEXT,
        image_path TEXT,
        date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_deleted INTEGER DEFAULT 0
    )`);

    const customerCols = await dbAll("PRAGMA table_info(customers)");
    if (!customerCols.some(c => c.name === 'is_deleted')) {
        await dbRun("ALTER TABLE customers ADD COLUMN is_deleted INTEGER DEFAULT 0");
    }
    if (!customerCols.some(c => c.name === 'image_path')) {
        await dbRun("ALTER TABLE customers ADD COLUMN image_path TEXT");
    }
    if (!customerCols.some(c => c.name === 'vehicle_number')) {
        await dbRun("ALTER TABLE customers ADD COLUMN vehicle_number TEXT");
    }
    if (!customerCols.some(c => c.name === 'station_name')) {
        await dbRun("ALTER TABLE customers ADD COLUMN station_name TEXT");
    }

    try {
        await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_id_number ON customers(id_number) WHERE id_number IS NOT NULL AND id_number != ''");
    } catch (_) { }

    // 4. Sales Table
    await dbRun(`CREATE TABLE IF NOT EXISTS sales (
        sale_id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        walkin_name TEXT,
        walkin_id INTEGER,
        sale_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_amount REAL NOT NULL,
        payment_type TEXT CHECK(payment_type IN ('Cash', 'Installment')) NOT NULL,
        status TEXT DEFAULT 'Completed',
        is_hidden INTEGER DEFAULT 0,
        is_deleted INTEGER DEFAULT 0,
        FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL
    )`);

    const salesCols = await dbAll("PRAGMA table_info(sales)");
    if (!salesCols.some(c => c.name === 'is_hidden')) {
        await dbRun("ALTER TABLE sales ADD COLUMN is_hidden INTEGER DEFAULT 0");
    }
    if (!salesCols.some(c => c.name === 'is_deleted')) {
        await dbRun("ALTER TABLE sales ADD COLUMN is_deleted INTEGER DEFAULT 0");
    }
    if (!salesCols.some(c => c.name === 'walkin_name')) {
        await dbRun("ALTER TABLE sales ADD COLUMN walkin_name TEXT");
    }
    if (!salesCols.some(c => c.name === 'walkin_id')) {
        await dbRun("ALTER TABLE sales ADD COLUMN walkin_id INTEGER");
    }

    // 5. Sale Items Table
    await dbRun(`CREATE TABLE IF NOT EXISTS sale_items (
        sale_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        product_id INTEGER,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        subtotal REAL NOT NULL,
        purchase_price REAL DEFAULT 0,
        returned_qty INTEGER DEFAULT 0,
        FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE SET NULL
    )`);

    const siCols = await dbAll("PRAGMA table_info(sale_items)");
    if (!siCols.some(c => c.name === 'purchase_price')) {
        await dbRun("ALTER TABLE sale_items ADD COLUMN purchase_price REAL DEFAULT 0");
    }
    if (!siCols.some(c => c.name === 'returned_qty')) {
        await dbRun("ALTER TABLE sale_items ADD COLUMN returned_qty INTEGER DEFAULT 0");
    }

    // 6. Installments Table
    await dbRun(`CREATE TABLE IF NOT EXISTS installments (
        installment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        down_payment REAL DEFAULT 0,
        total_amount REAL NOT NULL,
        remaining_balance REAL NOT NULL,
        monthly_amount REAL NOT NULL,
        installment_duration INTEGER NOT NULL,
        next_due_date DATE NOT NULL,
        status TEXT CHECK(status IN ('Active', 'Completed', 'Overdue')) DEFAULT 'Active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        guarantor_name TEXT,
        guarantor_cnic TEXT,
        guarantor_mobile TEXT,
        guarantor_address TEXT,
        is_deleted INTEGER DEFAULT 0,
        FOREIGN KEY (sale_id) REFERENCES sales(sale_id) ON DELETE CASCADE
    )`);

    const installmentCols = await dbAll("PRAGMA table_info(installments)");
    if (!installmentCols.some(c => c.name === 'guarantor_name')) {
        await dbRun("ALTER TABLE installments ADD COLUMN guarantor_name TEXT");
    }
    if (!installmentCols.some(c => c.name === 'guarantor_cnic')) {
        await dbRun("ALTER TABLE installments ADD COLUMN guarantor_cnic TEXT");
    }
    if (!installmentCols.some(c => c.name === 'guarantor_mobile')) {
        await dbRun("ALTER TABLE installments ADD COLUMN guarantor_mobile TEXT");
    }
    if (!installmentCols.some(c => c.name === 'guarantor_address')) {
        await dbRun("ALTER TABLE installments ADD COLUMN guarantor_address TEXT");
    }
    if (!installmentCols.some(c => c.name === 'is_deleted')) {
        await dbRun("ALTER TABLE installments ADD COLUMN is_deleted INTEGER DEFAULT 0");
    }

    // 7. Installment Payments Table
    await dbRun(`CREATE TABLE IF NOT EXISTS installment_payments (
        payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        installment_id INTEGER NOT NULL,
        payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        amount_paid REAL NOT NULL,
        payment_method TEXT DEFAULT 'Cash',
        remaining_balance_after REAL NOT NULL,
        FOREIGN KEY (installment_id) REFERENCES installments(installment_id) ON DELETE CASCADE
    )`);

    const paymentCols = await dbAll("PRAGMA table_info(installment_payments)");
    if (!paymentCols.some(c => c.name === 'payment_method')) {
        await dbRun("ALTER TABLE installment_payments ADD COLUMN payment_method TEXT DEFAULT 'Cash'");
    }



    // Installments table migrations
    const instCols = await dbAll("PRAGMA table_info(installments)");
    if (!instCols.some(c => c.name === 'vehicle_number')) {
        await dbRun("ALTER TABLE installments ADD COLUMN vehicle_number TEXT");
    }
    if (!instCols.some(c => c.name === 'fuel_type')) {
        await dbRun("ALTER TABLE installments ADD COLUMN fuel_type TEXT");
    }
    if (!instCols.some(c => c.name === 'liters_bought')) {
        await dbRun("ALTER TABLE installments ADD COLUMN liters_bought REAL DEFAULT 0");
    }

    // 8. Expenses Table
    await dbRun(`CREATE TABLE IF NOT EXISTS expenses (
        expense_id INTEGER PRIMARY KEY AUTOINCREMENT,
        expense_date DATE DEFAULT (DATE('now', 'localtime')),
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        payment_method TEXT DEFAULT 'Cash',
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 9. Activity Logs Table
    await dbRun(`CREATE TABLE IF NOT EXISTS activity_logs (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 10. Indexes
    await dbRun('CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_installments_sale ON installments(sale_id)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_installments_status ON installments(status)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_installments_due_date ON installments(next_due_date)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_payments_installment ON installment_payments(installment_id)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)');

    // Seed Default Fuels (Petrol & Diesel)
    const petrol = await dbGet('SELECT * FROM products WHERE name = ?', ['Petrol (Super)']);
    if (!petrol) {
        await dbRun(`INSERT INTO products (name, category, brand, purchase_price, selling_price, stock_qty, min_stock_level, supplier_name, warranty_period)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['Petrol (Super)', 'Fuel', 'Super', 270.00, 280.00, 15000, 2000, 'PSO / Shell', 'N/A']);
    }
    const diesel = await dbGet('SELECT * FROM products WHERE name = ?', ['Diesel (HSD)']);
    if (!diesel) {
        await dbRun(`INSERT INTO products (name, category, brand, purchase_price, selling_price, stock_qty, min_stock_level, supplier_name, warranty_period)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['Diesel (HSD)', 'Fuel', 'HSD', 275.00, 285.00, 20000, 2500, 'PSO / Shell', 'N/A']);
    }
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function getDatabase() {
    return db;
}

// Activity Logging with automatic pruning (keeps last 3000)
async function logActivity(username, action, details) {
    if (!db) return;
    try {
        const sql = 'INSERT INTO activity_logs (username, action, details) VALUES (?, ?, ?)';
        await dbRun(sql, [username, action, details]);

        if (Math.random() < 0.1) {
            await dbRun(`
                DELETE FROM activity_logs 
                WHERE log_id NOT IN (
                    SELECT log_id FROM activity_logs 
                    ORDER BY log_id DESC LIMIT 3000
                )
            `);
        }
    } catch (error) {
        console.error('Failed to log activity:', error);
    }
}

// Configuration & status helpers for UI
function getDbConfig() {
    return {
        type: 'sqlite',
        path: getDbPath(),
        status: db ? 'connected' : 'disconnected'
    };
}

function saveDbConfig(config) {
    return { success: true, message: 'SQLite database configuration active' };
}

async function testConnection() {
    if (db) {
        return { success: true, message: 'SQLite database is connected and active!' };
    }
    return { success: false, message: 'SQLite database is not initialized.' };
}

module.exports = {
    getDatabase,
    initializeDatabase,
    hashPassword,
    logActivity,
    dbGet,
    dbAll,
    dbRun,
    withTransaction,
    getDbPath,
    getDbConfig,
    saveDbConfig,
    testConnection,
    get db() {
        return db;
    }
};
