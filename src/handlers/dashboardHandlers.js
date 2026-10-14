function registerDashboardHandlers(context) {
    const { ipcMain, dbModule } = context;

    ipcMain.handle('get-dashboard-stats', async () => {
        try {
            const stats = {};

            const dailyQuery = `
                SELECT (
                    SELECT COALESCE(SUM(
                        CASE WHEN s.payment_type = 'Cash' THEN s.total_amount
                             WHEN s.payment_type = 'Installment' THEN COALESCE(i.down_payment, 0)
                             ELSE 0 END
                    ), 0)
                    FROM sales s
                    LEFT JOIN installments i ON s.sale_id = i.sale_id
                    WHERE DATE(s.sale_date, 'localtime') = DATE('now', 'localtime') AND s.is_deleted = 0
                ) + (
                    SELECT COALESCE(SUM(ip.amount_paid), 0)
                    FROM installment_payments ip
                    JOIN installments i ON ip.installment_id = i.installment_id
                    JOIN sales s ON i.sale_id = s.sale_id
                    WHERE DATE(ip.payment_date, 'localtime') = DATE('now', 'localtime') AND s.is_deleted = 0
                ) as total
            `;
            const dailyRow = await dbModule.dbGet(dailyQuery);
            stats.daily_sales = dailyRow ? dailyRow.total : 0;

            const monthlyQuery = `
                SELECT (
                    SELECT COALESCE(SUM(
                        CASE WHEN s.payment_type = 'Cash' THEN s.total_amount
                             WHEN s.payment_type = 'Installment' THEN COALESCE(i.down_payment, 0)
                             ELSE 0 END
                    ), 0)
                    FROM sales s
                    LEFT JOIN installments i ON s.sale_id = i.sale_id
                    WHERE strftime('%Y-%m', s.sale_date, 'localtime') = strftime('%Y-%m', 'now', 'localtime') AND s.is_deleted = 0
                ) + (
                    SELECT COALESCE(SUM(ip.amount_paid), 0)
                    FROM installment_payments ip
                    JOIN installments i ON ip.installment_id = i.installment_id
                    JOIN sales s ON i.sale_id = s.sale_id
                    WHERE strftime('%Y-%m', ip.payment_date, 'localtime') = strftime('%Y-%m', 'now', 'localtime') AND s.is_deleted = 0
                ) as total
            `;
            const monthlyRow = await dbModule.dbGet(monthlyQuery);
            stats.monthly_sales = monthlyRow ? monthlyRow.total : 0;

            const pendingRow = await dbModule.dbGet(`
                SELECT COALESCE(SUM(remaining_balance), 0) as total 
                FROM installments i
                JOIN sales s ON i.sale_id = s.sale_id
                WHERE i.status IN ('Active', 'Overdue') AND s.is_deleted = 0 AND i.is_deleted = 0
            `);
            stats.pending_installments = pendingRow ? pendingRow.total : 0;

            const overdueRow = await dbModule.dbGet(`
                SELECT COUNT(*) as count 
                FROM installments i
                JOIN sales s ON i.sale_id = s.sale_id
                WHERE (i.status = 'Overdue' OR (i.status = 'Active' AND DATE(i.next_due_date) < DATE('now', 'localtime'))) AND s.is_deleted = 0 AND i.is_deleted = 0
            `);
            stats.overdue_count = overdueRow ? overdueRow.count : 0;

            // Daily & Monthly Expenses
            const dailyExpenseRow = await dbModule.dbGet(`
                SELECT COALESCE(SUM(amount), 0) as total 
                FROM expenses 
                WHERE DATE(expense_date, 'localtime') = DATE('now', 'localtime')
            `);
            stats.daily_expenses = dailyExpenseRow ? dailyExpenseRow.total : 0;

            const monthlyExpenseRow = await dbModule.dbGet(`
                SELECT COALESCE(SUM(amount), 0) as total 
                FROM expenses 
                WHERE strftime('%Y-%m', expense_date, 'localtime') = strftime('%Y-%m', 'now', 'localtime')
            `);
            stats.monthly_expenses = monthlyExpenseRow ? monthlyExpenseRow.total : 0;

            // Fuel Tanks Stock & Live Rates
            const petrolRow = await dbModule.dbGet(`SELECT stock_qty, selling_price as sale_price FROM products WHERE name LIKE '%Petrol%' LIMIT 1`);
            stats.petrol_stock = petrolRow ? Number(petrolRow.stock_qty) : 0;
            stats.petrol_price = petrolRow ? Number(petrolRow.sale_price) : 0;

            const dieselRow = await dbModule.dbGet(`SELECT stock_qty, selling_price as sale_price FROM products WHERE name LIKE '%Diesel%' LIMIT 1`);
            stats.diesel_stock = dieselRow ? Number(dieselRow.stock_qty) : 0;
            stats.diesel_price = dieselRow ? Number(dieselRow.sale_price) : 0;

            const lowStockRow = await dbModule.dbGet(`SELECT COUNT(*) as count FROM products WHERE stock_qty < min_stock_level`);
            stats.low_stock_count = lowStockRow ? lowStockRow.count : 0;

            const customerRow = await dbModule.dbGet(`SELECT COUNT(*) as count FROM customers WHERE is_deleted = 0`);
            stats.total_customers = customerRow ? customerRow.count : 0;

            return { success: true, stats };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('get-dashboard-alerts', async () => {
        try {
            const alerts = [];

            const products = await dbModule.dbAll('SELECT * FROM products WHERE stock_qty < min_stock_level');
            products.forEach(p => {
                alerts.push({
                    severity: 'warning',
                    title: 'Low Fuel Warning',
                    message: `${p.name} tank level is low (${p.stock_qty} Liters remaining, min: ${p.min_stock_level} L)`,
                    type: 'low-stock',
                    target: 'inventory'
                });
            });

            const overdueInstallments = await dbModule.dbAll(`
                SELECT i.*, COALESCE(c.full_name, s.walkin_name) as full_name, c.station_name, c.vehicle_number
                FROM installments i
                JOIN sales s ON i.sale_id = s.sale_id
                LEFT JOIN customers c ON s.customer_id = c.customer_id
                WHERE (i.status = 'Overdue' OR (i.status = 'Active' AND DATE(i.next_due_date) < DATE('now', 'localtime'))) AND s.is_deleted = 0 AND i.is_deleted = 0
            `);
            overdueInstallments.forEach(inst => {
                const clientLabel = inst.station_name ? `${inst.full_name} (${inst.station_name})` : (inst.full_name || 'Client');
                alerts.push({
                    severity: 'danger',
                    title: 'Overdue Client Balance',
                    message: `${clientLabel} has an overdue balance of Rs. ${(inst.remaining_balance || inst.monthly_amount).toLocaleString()}`,
                    type: 'overdue',
                    target: 'installments'
                });
            });

            const dueToday = await dbModule.dbAll(`
                SELECT i.*, COALESCE(c.full_name, s.walkin_name) as full_name, c.station_name, c.vehicle_number
                FROM installments i
                JOIN sales s ON i.sale_id = s.sale_id
                LEFT JOIN customers c ON s.customer_id = c.customer_id
                WHERE i.status = 'Active' AND DATE(i.next_due_date) = DATE('now', 'localtime') AND s.is_deleted = 0 AND i.is_deleted = 0
            `);
            dueToday.forEach(inst => {
                const clientLabel = inst.station_name ? `${inst.full_name} (${inst.station_name})` : (inst.full_name || 'Client');
                alerts.push({
                    severity: 'warning',
                    title: 'Balance Payment Due Today',
                    message: `${clientLabel} has a payment due today (Rs. ${(inst.monthly_amount || inst.remaining_balance).toLocaleString()})`,
                    type: 'due-today',
                    target: 'installments'
                });
            });

            return { success: true, alerts };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });
}

module.exports = registerDashboardHandlers;
