const sqlite3 = require('sqlite3').verbose();
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

async function migrateMysqlToSqlite(targetSqlitePath) {
    const sqlitePath = targetSqlitePath || path.join(__dirname, '..', 'esms.db');
    console.log(`Starting migration from MySQL to SQLite (${sqlitePath})...`);

    // 1. MySQL config
    let config = {
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'afras7988',
        database: 'fridge_agency'
    };

    const configPath = path.join(__dirname, '..', 'db_config.json');
    if (fs.existsSync(configPath)) {
        try {
            config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
        } catch (e) {
            console.warn('Could not read db_config.json, using defaults.');
        }
    }

    let mysqlConn;
    try {
        mysqlConn = await mysql.createConnection({
            host: config.host,
            port: Number(config.port) || 3306,
            user: config.user,
            password: config.password,
            database: config.database,
            dateStrings: true
        });
        console.log(`✓ Connected to MySQL database "${config.database}"`);
    } catch (err) {
        console.error('MySQL connection failed:', err.message);
        return { success: false, message: `MySQL connection failed: ${err.message}` };
    }

    // 2. Open / create SQLite database
    const sqliteDb = new sqlite3.Database(sqlitePath);
    const runSqlite = (sql, params = []) => new Promise((resolve, reject) => {
        sqliteDb.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });

    try {
        await runSqlite('PRAGMA foreign_keys = OFF');

        // Create tables if not exist
        await runSqlite(`CREATE TABLE IF NOT EXISTS admin (
            admin_id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            profile_image TEXT,
            recovery_code TEXT
        )`);

        await runSqlite(`CREATE TABLE IF NOT EXISTS products (
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

        await runSqlite(`CREATE TABLE IF NOT EXISTS customers (
            customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            address TEXT,
            id_number TEXT,
            email TEXT,
            image_path TEXT,
            vehicle_number TEXT,
            station_name TEXT,
            date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER DEFAULT 0
        )`);

        await runSqlite(`CREATE TABLE IF NOT EXISTS sales (
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

        await runSqlite(`CREATE TABLE IF NOT EXISTS sale_items (
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

        await runSqlite(`CREATE TABLE IF NOT EXISTS installments (
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

        await runSqlite(`CREATE TABLE IF NOT EXISTS installment_payments (
            payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
            installment_id INTEGER NOT NULL,
            payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            amount_paid REAL NOT NULL,
            payment_method TEXT DEFAULT 'Cash',
            remaining_balance_after REAL NOT NULL,
            FOREIGN KEY (installment_id) REFERENCES installments(installment_id) ON DELETE CASCADE
        )`);

        await runSqlite(`CREATE TABLE IF NOT EXISTS activity_logs (
            log_id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Create indexes
        await runSqlite('CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)');
        await runSqlite('CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date)');
        await runSqlite('CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)');
        await runSqlite('CREATE INDEX IF NOT EXISTS idx_installments_sale ON installments(sale_id)');
        await runSqlite('CREATE INDEX IF NOT EXISTS idx_installments_status ON installments(status)');
        await runSqlite('CREATE INDEX IF NOT EXISTS idx_installments_due_date ON installments(next_due_date)');
        await runSqlite('CREATE INDEX IF NOT EXISTS idx_payments_installment ON installment_payments(installment_id)');

        // Clear existing SQLite tables for a clean migration
        await runSqlite('DELETE FROM activity_logs');
        await runSqlite('DELETE FROM installment_payments');
        await runSqlite('DELETE FROM installments');
        await runSqlite('DELETE FROM sale_items');
        await runSqlite('DELETE FROM sales');
        await runSqlite('DELETE FROM customers');
        await runSqlite('DELETE FROM products');
        await runSqlite('DELETE FROM admin');

        // Migrate admin
        const [admins] = await mysqlConn.query('SELECT * FROM admin');
        console.log(`Migrating ${admins.length} admin records...`);
        for (const a of admins) {
            await runSqlite(
                `INSERT OR REPLACE INTO admin (admin_id, username, password, created_at, profile_image, recovery_code)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [a.admin_id, a.username, a.password, a.created_at, a.profile_image, a.recovery_code]
            );
        }

        // Migrate products
        const [products] = await mysqlConn.query('SELECT * FROM products');
        console.log(`Migrating ${products.length} products...`);
        for (const p of products) {
            await runSqlite(
                `INSERT OR REPLACE INTO products (product_id, name, category, brand, purchase_price, selling_price, stock_qty, min_stock_level, supplier_name, warranty_period, date_added, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [p.product_id, p.name, p.category, p.brand, p.purchase_price, p.selling_price, p.stock_qty, p.min_stock_level, p.supplier_name, p.warranty_period, p.date_added, p.last_updated]
            );
        }

        // Migrate customers
        const [customers] = await mysqlConn.query('SELECT * FROM customers');
        console.log(`Migrating ${customers.length} customers...`);
        for (const c of customers) {
            await runSqlite(
                `INSERT OR REPLACE INTO customers (customer_id, full_name, phone, address, id_number, email, image_path, date_added, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [c.customer_id, c.full_name, c.phone, c.address, c.id_number, c.email, c.image_path, c.date_added, c.is_deleted || 0]
            );
        }

        // Migrate sales
        const [sales] = await mysqlConn.query('SELECT * FROM sales');
        console.log(`Migrating ${sales.length} sales...`);
        for (const s of sales) {
            await runSqlite(
                `INSERT OR REPLACE INTO sales (sale_id, customer_id, walkin_name, walkin_id, sale_date, total_amount, payment_type, status, is_hidden, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [s.sale_id, s.customer_id, s.walkin_name, s.walkin_id, s.sale_date, s.total_amount, s.payment_type, s.status || 'Completed', s.is_hidden || 0, s.is_deleted || 0]
            );
        }

        // Migrate sale_items
        const [saleItems] = await mysqlConn.query('SELECT * FROM sale_items');
        console.log(`Migrating ${saleItems.length} sale items...`);
        for (const si of saleItems) {
            await runSqlite(
                `INSERT OR REPLACE INTO sale_items (sale_item_id, sale_id, product_id, product_name, quantity, unit_price, subtotal, purchase_price, returned_qty)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [si.sale_item_id, si.sale_id, si.product_id, si.product_name, si.quantity, si.unit_price, si.subtotal, si.purchase_price || 0, si.returned_qty || 0]
            );
        }

        // Migrate installments
        const [installments] = await mysqlConn.query('SELECT * FROM installments');
        console.log(`Migrating ${installments.length} installments...`);
        for (const inst of installments) {
            await runSqlite(
                `INSERT OR REPLACE INTO installments (installment_id, sale_id, down_payment, total_amount, remaining_balance, monthly_amount, installment_duration, next_due_date, status, created_at, guarantor_name, guarantor_cnic, guarantor_mobile, guarantor_address, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [inst.installment_id, inst.sale_id, inst.down_payment, inst.total_amount, inst.remaining_balance, inst.monthly_amount, inst.installment_duration, inst.next_due_date, inst.status, inst.created_at, inst.guarantor_name, inst.guarantor_cnic, inst.guarantor_mobile, inst.guarantor_address, inst.is_deleted || 0]
            );
        }

        // Migrate installment_payments
        const [payments] = await mysqlConn.query('SELECT * FROM installment_payments');
        console.log(`Migrating ${payments.length} installment payments...`);
        for (const ip of payments) {
            await runSqlite(
                `INSERT OR REPLACE INTO installment_payments (payment_id, installment_id, payment_date, amount_paid, payment_method, remaining_balance_after)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [ip.payment_id, ip.installment_id, ip.payment_date, ip.amount_paid, ip.payment_method || 'Cash', ip.remaining_balance_after]
            );
        }

        // Migrate activity_logs
        const [logs] = await mysqlConn.query('SELECT * FROM activity_logs');
        console.log(`Migrating ${logs.length} activity logs...`);
        for (const l of logs) {
            await runSqlite(
                `INSERT OR REPLACE INTO activity_logs (log_id, username, action, details, timestamp)
                 VALUES (?, ?, ?, ?, ?)`,
                [l.log_id, l.username, l.action, l.details, l.timestamp]
            );
        }

        await runSqlite('PRAGMA foreign_keys = ON');

        console.log('✓ Migration from MySQL to SQLite completed successfully!');
        return {
            success: true,
            counts: {
                admins: admins.length,
                products: products.length,
                customers: customers.length,
                sales: sales.length,
                saleItems: saleItems.length,
                installments: installments.length,
                payments: payments.length,
                logs: logs.length
            }
        };
    } catch (err) {
        console.error('Migration error:', err);
        return { success: false, message: err.message };
    } finally {
        await mysqlConn.end();
        await new Promise(resolve => sqliteDb.close(resolve));
    }
}

if (require.main === module) {
    migrateMysqlToSqlite()
        .then(result => {
            console.log('Result:', result);
            process.exit(result.success ? 0 : 1);
        })
        .catch(err => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
}

module.exports = { migrateMysqlToSqlite };
