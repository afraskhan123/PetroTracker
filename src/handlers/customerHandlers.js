const fs = require('fs');
const path = require('path');

function registerCustomerHandlers(context) {
    const { ipcMain, dbModule, getCurrentUser } = context;

    function processCustomerImage(imagePath) {
        if (!imagePath) return null;
        if (imagePath.startsWith('data:image/')) return imagePath;
        if (fs.existsSync(imagePath)) {
            try {
                const ext = path.extname(imagePath).slice(1) || 'png';
                const b64 = fs.readFileSync(imagePath).toString('base64');
                return `data:image/${ext};base64,${b64}`;
            } catch (e) {
                console.error('Error processing customer image:', e);
            }
        }
        return null;
    }

    ipcMain.handle('get-all-customers', async () => {
        try {
            const rows = await dbModule.dbAll('SELECT * FROM customers WHERE is_deleted = 0 ORDER BY customer_id DESC');
            const processedRows = rows.map(row => ({
                ...row,
                image_path: processCustomerImage(row.image_path)
            }));
            return { success: true, customers: processedRows };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('add-customer', async (event, customer) => {
        try {
            const { fullName, phone, idNumber, address, email, imageData, vehicleNumber, vehicle_number, stationName, station_name } = customer;
            const finalVehicle = vehicleNumber || vehicle_number || null;
            const finalStation = stationName || station_name || null;

            // Uniqueness check for id_number (Ignore soft-deleted records)
            if (idNumber && idNumber.trim() !== '') {
                const existing = await dbModule.dbGet(
                    'SELECT customer_id FROM customers WHERE id_number = ? AND is_deleted = 0',
                    [idNumber.trim()]
                );
                if (existing) {
                    return { success: false, message: 'Customer CNIC already exists' };
                }
            }

            // Centralized image storage
            const finalImage = imageData || null;

            const query = 'INSERT INTO customers (full_name, phone, id_number, address, email, image_path, vehicle_number, station_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
            const result = await dbModule.dbRun(query, [
                fullName,
                phone,
                idNumber ? idNumber.trim() : null,
                address,
                email,
                finalImage,
                finalVehicle,
                finalStation
            ]);

            const newId = result.insertId;
            await dbModule.logActivity(
                getCurrentUser()?.username || 'admin',
                'Add Customer',
                `Added customer/client: ${fullName}. Station: ${finalStation || 'N/A'}, Vehicle: ${finalVehicle || 'N/A'} (ID: ${newId})`
            );

            return { success: true, message: 'Client added successfully', customer_id: newId };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('update-customer', async (event, customer) => {
        try {
            const { customer_id, fullName, phone, address, idNumber, email, imageData, imagePath, vehicleNumber, vehicle_number, stationName, station_name } = customer;
            const finalVehicle = vehicleNumber || vehicle_number || null;
            const finalStation = stationName || station_name || null;

            // Uniqueness check for id_number
            if (idNumber && idNumber.trim() !== '') {
                const existing = await dbModule.dbGet(
                    'SELECT customer_id FROM customers WHERE id_number = ? AND customer_id != ? AND is_deleted = 0',
                    [idNumber.trim(), customer_id]
                );
                if (existing) {
                    return { success: false, message: 'Customer CNIC already exists' };
                }
            }

            const finalImage = imageData || imagePath || null;

            const query = 'UPDATE customers SET full_name = ?, phone = ?, address = ?, id_number = ?, email = ?, image_path = ?, vehicle_number = ?, station_name = ? WHERE customer_id = ?';
            await dbModule.dbRun(query, [
                fullName,
                phone,
                address,
                idNumber ? idNumber.trim() : null,
                email,
                finalImage,
                finalVehicle,
                finalStation,
                customer_id
            ]);

            await dbModule.logActivity(
                getCurrentUser()?.username || 'admin',
                'Update Customer',
                `Updated client: ${fullName} (ID: ${customer_id})`
            );

            return { success: true, message: 'Client updated successfully' };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('delete-customer', async (event, customer_id) => {
        try {
            // Check if customer has any active or overdue installments
            const checkQuery = `
                SELECT i.status 
                FROM installments i
                JOIN sales s ON i.sale_id = s.sale_id
                WHERE s.customer_id = ? AND i.status IN ('Active', 'Overdue') AND s.is_deleted = 0 AND i.is_deleted = 0
            `;
            const activeInstallments = await dbModule.dbAll(checkQuery, [customer_id]);

            if (activeInstallments && activeInstallments.length > 0) {
                return {
                    success: false,
                    message: 'Cannot delete this client. They have pending or overdue balance ledger entries. Please clear or complete the balance first.'
                };
            }

            // Soft delete: Mark customer as deleted but keep record for reports/invoices
            await dbModule.dbRun('UPDATE customers SET is_deleted = 1 WHERE customer_id = ?', [customer_id]);
            await dbModule.logActivity(
                getCurrentUser()?.username || 'admin',
                'Delete Customer',
                `Deleted client ID: ${customer_id}`
            );

            return { success: true, message: 'Client deleted successfully' };
        } catch (err) {
            return { success: false, message: 'Failed to delete client: ' + err.message };
        }
    });

    ipcMain.handle('search-customers', async (event, searchTerm) => {
        try {
            const query = `
                SELECT * FROM customers 
                WHERE is_deleted = 0 AND (
                    full_name LIKE ? OR 
                    phone LIKE ? OR 
                    vehicle_number LIKE ? OR 
                    station_name LIKE ? OR
                    id_number LIKE ?
                ) 
                ORDER BY customer_id DESC
            `;
            const term = `%${searchTerm}%`;
            const rows = await dbModule.dbAll(query, [term, term, term, term, term]);
            const processedRows = rows.map(row => ({
                ...row,
                image_path: processCustomerImage(row.image_path)
            }));
            return { success: true, customers: processedRows };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('get-customer-history', async (event, customer_id) => {
        try {
            const query = `
                SELECT s.*, 
                       GROUP_CONCAT(si.product_name || ' (' || si.quantity || ' L)', ', ') as items,
                       i.installment_id, i.remaining_balance, i.status as installment_status
                FROM sales s
                LEFT JOIN sale_items si ON s.sale_id = si.sale_id
                LEFT JOIN installments i ON s.sale_id = i.sale_id
                WHERE s.customer_id = ? AND s.is_deleted = 0
                GROUP BY s.sale_id, i.installment_id, i.remaining_balance, i.status
                ORDER BY s.sale_date DESC
            `;

            const rows = await dbModule.dbAll(query, [customer_id]);
            const sales = rows.map(row => ({
                ...row,
                installment: row.installment_id ? {
                    installment_id: row.installment_id,
                    remaining_balance: row.remaining_balance,
                    status: row.installment_status
                } : null
            }));

            return { success: true, sales };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });
}

module.exports = registerCustomerHandlers;
