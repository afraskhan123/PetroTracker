function registerExpenseHandlers(context) {
    const { ipcMain, dbModule, getCurrentUser } = context;

    // Get all expenses with optional filters
    ipcMain.handle('get-all-expenses', async (event, filters = {}) => {
        try {
            let query = 'SELECT * FROM expenses WHERE 1=1';
            const params = [];

            if (filters.date) {
                query += ' AND DATE(expense_date) = DATE(?)';
                params.push(filters.date);
            } else if (filters.startDate && filters.endDate) {
                query += ' AND DATE(expense_date) BETWEEN DATE(?) AND DATE(?)';
                params.push(filters.startDate, filters.endDate);
            }

            if (filters.category) {
                query += ' AND category = ?';
                params.push(filters.category);
            }

            query += ' ORDER BY expense_date DESC, expense_id DESC';

            const expenses = await dbModule.dbAll(query, params);
            const totalAmount = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

            return { success: true, expenses, totalAmount };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    // Add new expense
    ipcMain.handle('add-expense', async (event, expenseData) => {
        try {
            const { expense_date, category, amount, payment_method, description } = expenseData;

            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                return { success: false, message: 'Expense amount must be greater than zero' };
            }

            if (!category || !category.trim()) {
                return { success: false, message: 'Expense category is required' };
            }

            const targetDate = expense_date || new Date().toISOString().split('T')[0];

            const result = await dbModule.dbRun(
                'INSERT INTO expenses (expense_date, category, amount, payment_method, description) VALUES (?, ?, ?, ?, ?)',
                [targetDate, category.trim(), parsedAmount, payment_method || 'Cash', description || '']
            );

            await dbModule.logActivity(
                getCurrentUser()?.username || 'admin',
                'Add Expense',
                `Added expense: ${category} - Rs. ${parsedAmount} (${payment_method || 'Cash'})`
            );

            return { success: true, message: 'Expense recorded successfully', expense_id: result.insertId };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    // Update expense
    ipcMain.handle('update-expense', async (event, expenseData) => {
        try {
            const { expense_id, expense_date, category, amount, payment_method, description } = expenseData;

            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                return { success: false, message: 'Expense amount must be greater than zero' };
            }

            await dbModule.dbRun(
                'UPDATE expenses SET expense_date = ?, category = ?, amount = ?, payment_method = ?, description = ? WHERE expense_id = ?',
                [expense_date, category.trim(), parsedAmount, payment_method || 'Cash', description || '', expense_id]
            );

            await dbModule.logActivity(
                getCurrentUser()?.username || 'admin',
                'Update Expense',
                `Updated expense ID ${expense_id}: ${category} - Rs. ${parsedAmount}`
            );

            return { success: true, message: 'Expense updated successfully' };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    // Delete expense
    ipcMain.handle('delete-expense', async (event, expense_id) => {
        try {
            await dbModule.dbRun('DELETE FROM expenses WHERE expense_id = ?', [expense_id]);
            await dbModule.logActivity(
                getCurrentUser()?.username || 'admin',
                'Delete Expense',
                `Deleted expense ID ${expense_id}`
            );
            return { success: true, message: 'Expense deleted successfully' };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    // Get daily expenses total
    ipcMain.handle('get-daily-expenses-total', async (event, date) => {
        try {
            const targetDate = date || new Date().toISOString().split('T')[0];
            const row = await dbModule.dbGet(
                'SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE DATE(expense_date) = DATE(?)',
                [targetDate]
            );
            return { success: true, total: row ? row.total : 0, date: targetDate };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    // Default expense categories
    ipcMain.handle('get-expense-categories', async () => {
        return {
            success: true,
            categories: [
                'Generator Fuel / Maintenance',
                'Staff Salary / Advance',
                'Electricity / Water Bills',
                'Tea & Food / Mess',
                'Pump Maintenance & Repair',
                'Government / TMA / Explosives Fees',
                'Office & Stationary',
                'Security / Guard',
                'Miscellaneous'
            ]
        };
    });
}

module.exports = registerExpenseHandlers;
