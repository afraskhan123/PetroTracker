# ESMS - User & Administrator Guide

Welcome to the **ESMS (Electronic Store Management System)** User & Administration Guide. This folder contains all the technical and operational documentation for running, maintaining, and scaling the system.

---

## 📑 Table of Contents

1. [Quick Start & Default Credentials](#1-quick-start--default-credentials)
2. [Database Architecture (SQLite)](#2-database-architecture-sqlite)
3. [Data Management, Backups & Migration Tools](#3-data-management-backups--migration-tools)
4. [Building the Desktop Installer (.exe)](#4-building-the-desktop-installer-exe)
5. [Troubleshooting & FAQs](#5-troubleshooting--faqs)

---

## 1. Quick Start & Default Credentials

### Running the Application (Development)
```bash
npm start
```
*(or `npm run dev`)*

### Default Admin Login
* **Username:** `admin`
* **Password:** `admin123`
* **Recovery Code:** `123456`

### Database Engine
* **Engine:** SQLite 3
* **Database File (Development):** `esms.db` (in the project root)
* **Database File (Installed/Production):** `%APPDATA%\ESMS\esms.db`

---

## 2. Database Architecture (SQLite)

The application runs on a high-performance local **SQLite (`esms.db`)** database:

* **Zero External Dependencies:** No need to install, configure, or run MySQL or external database servers. The application runs immediately out of the box.
* **Atomic Transactions:** All sales and inventory adjustments are wrapped in SQLite database transactions (`withTransaction`), guaranteeing data consistency and stock safety.
* **Auto-Schema Migration:** Tables, columns, and indexes are automatically verified and created on application launch.
* **Embedded Customer Photos:** Customer and profile photos are stored directly in the database as Base64 strings.

---

## 3. Google Drive & Cloud Backup Management

Navigate to **Settings $\rightarrow$ Google Drive & Cloud Backups** to manage automated and on-demand cloud backups.

### ☁️ How to Sync Backups Automatically to Google Drive
1. Install the free **[Google Drive for Desktop](https://www.google.com/drive/download/)** app on your computer.
2. Sign in with your Google account (this creates a virtual Google Drive, e.g., `G:\My Drive\` or `C:\Users\YourName\Google Drive\`).
3. In ESMS under **Settings $\rightarrow$ Google Drive & Cloud Backups**, either click **"Browse..."** or **paste your folder path directly** into the box and click **"Save Path"**:
   ```
   G:\My Drive\ESMS_Backups
   ```
4. Now, every automatic daily backup and manual backup created by ESMS will **instantly sync to your Google Drive cloud account**. You can view or download your backups from anywhere in the world at [drive.google.com](https://drive.google.com).

### 🛠️ Available Backup & Migration Features:
* **🇵🇰 Pakistani Timezone (PKT) Timestamps:** All backup files and folders are saved with precise Pakistani Standard Time (UTC+5) timestamps (e.g. `esms_backup_2026-10-13_09-06-25-PM.json`).
* **⚙️ When is Auto-Backup Taken?**
  1. **On Application Launch:** Automatically creates a backup snapshot 3 seconds after the app opens (once per day).
  2. **Periodic Background Checks:** Every 4 hours while the app remains open.
  3. **On Demand:** Any time you click **"Backup Now to Drive"**.
* **🛡️ Retention Pruning:** Automatically deletes backups older than 30 days (customizable) to prevent filling storage.
* **🕒 Recent Backups List & 1-Click Restore:** Displays a table of all existing backups with file size and creation date, allowing 1-click restore.
* **🔄 MySQL-to-SQLite Migration Tool:**
  To sync/migrate data from a local MySQL database (`fridge_agency`) into SQLite (`esms.db`), run:
  ```bash
  node scripts/migrate_mysql_to_sqlite.js
  ```
  *(Or click **"Re-Sync from MySQL"** in the Settings tab)*

---

## 4. Building the Desktop Installer (.exe)

To generate the standalone Windows installer for distribution:

```bash
npm run build
```

The installer executable will be created in the `dist/` directory:
```
dist/ESMS Setup 1.0.0.exe
```

---

## 5. Troubleshooting & FAQs

* **Forgot Admin Password:**
  * Click **"Forgot Password?"** on the login screen and enter the default recovery code: `123456`.
* **Where is the database located?**
  * In development mode: `d:\ExternalProj\ESMS\esms.db`.
  * In packaged application: `%APPDATA%\ESMS\esms.db`.
* **How do I back up my database manually?**
  * You can copy the `esms.db` file directly, or use **Export File (JSON)** / **Backup Now to Drive** in Settings.
