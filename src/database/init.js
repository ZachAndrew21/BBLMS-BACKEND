const mysql = require('mysql2/promise');

let pool;

function getDb() {
  if (!pool) {
    pool = mysql.createPool({
      host:              process.env.DB_HOST     || '127.0.0.1',
      port:              process.env.DB_PORT     || 3306,
      user:              process.env.DB_USER,
      password:          process.env.DB_PASSWORD,
      database:          process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit:   10,
      queueLimit:        0,
    });
  }
  return pool;
}

async function initializeDatabase() {
  const pool = getDb();
  try {
    const conn = await pool.getConnection();
    console.log(`MySQL connected → ${process.env.DB_HOST}:${process.env.DB_PORT || 3306} / ${process.env.DB_NAME}`);
    conn.release();

    const [statusColumns] = await pool.query(
      `SELECT COUNT(*) AS column_count
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME = 'status'`,
      [process.env.DB_NAME]
    );

    if ((statusColumns[0]?.column_count || 0) === 0) {
      await pool.query(
        `ALTER TABLE users
         ADD COLUMN status ENUM('APPROVED','PENDING','DENIED') DEFAULT 'APPROVED' AFTER is_admin`
      );
      await pool.query("UPDATE users SET status = 'APPROVED' WHERE status IS NULL OR status = ''");
      console.log('Migrated users.status column for account approval workflow');
    }

    // ── Migration: fine_paid flag on transactions ──────────────────────────────
    const [finePaidCol] = await pool.query(
      `SELECT COUNT(*) AS column_count
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME   = 'transactions'
         AND COLUMN_NAME  = 'fine_paid'`,
      [process.env.DB_NAME]
    );
    if ((finePaidCol[0]?.column_count || 0) === 0) {
      await pool.query(
        `ALTER TABLE transactions
         ADD COLUMN fine_paid TINYINT(1) NOT NULL DEFAULT 0 AFTER total_fine`
      );
      console.log('Migrated transactions.fine_paid column');
    }

    // ── Migration: new personal info fields on borrowers ────────────────────────
    const [borrowerCol] = await pool.query(
      `SELECT COUNT(*) AS column_count
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME   = 'borrowers'
         AND COLUMN_NAME  = 'middle_name'`,
      [process.env.DB_NAME]
    );
    if ((borrowerCol[0]?.column_count || 0) === 0) {
      await pool.query(
        `ALTER TABLE borrowers
         ADD COLUMN middle_name VARCHAR(100) DEFAULT '' AFTER firstname,
         ADD COLUMN gender ENUM('Male','Female','Other') DEFAULT 'Male' AFTER lastname,
         ADD COLUMN college ENUM('CTECH','CFES','CBM','COAS') DEFAULT 'CTECH' AFTER gender`
      );
      console.log('Migrated borrowers table (middle_name, gender, college)');
    }

    // ── Migration: heal borrower status mismatch ────────────────────────────────
    // If a user is APPROVED but their linked borrower is still Inactive (e.g. approved
    // before the approval route set borrowers.status), fix it automatically.
    const [healResult] = await pool.query(
      `UPDATE borrowers b
       JOIN users u ON u.user_id = b.id_no
       SET b.status = 'Active', b.updated_at = NOW()
       WHERE u.status = 'APPROVED' AND b.status = 'Inactive'`
    );
    if (healResult.affectedRows > 0) {
      console.log(`Healed ${healResult.affectedRows} borrower(s) with APPROVED user but Inactive borrower status`);
    }

    // ── Migration: fine_payments table ─────────────────────────────────────────
    const [fpTable] = await pool.query(
      `SELECT COUNT(*) AS table_count
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME   = 'fine_payments'`,
      [process.env.DB_NAME]
    );
    if ((fpTable[0]?.table_count || 0) === 0) {
      await pool.query(
        `CREATE TABLE fine_payments (
           id                  INT(11)        NOT NULL AUTO_INCREMENT,
           transaction_id      INT(11)        NOT NULL,
           fine_amount         DECIMAL(10,2)  NOT NULL DEFAULT '0.00',
           amount_paid         DECIMAL(10,2)  NOT NULL DEFAULT '0.00',
           change_given        DECIMAL(10,2)  NOT NULL DEFAULT '0.00',
           payment_type        ENUM('Cash')   NOT NULL DEFAULT 'Cash',
           payment_status      ENUM('Paid','Void') NOT NULL DEFAULT 'Paid',
           received_by_user_id VARCHAR(50)    NOT NULL DEFAULT '',
           receipt_no          VARCHAR(30)    NOT NULL DEFAULT '',
           notes               TEXT,
           paid_at             DATETIME       DEFAULT CURRENT_TIMESTAMP,
           created_at          DATETIME       DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (id),
           UNIQUE KEY uk_fine_payments_receipt (receipt_no),
           KEY idx_fine_payments_transaction (transaction_id),
           KEY idx_fine_payments_status (payment_status),
           CONSTRAINT fk_fine_payments_transaction
             FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE CASCADE
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
      console.log('Created fine_payments table');
    }

    // ── Migration: incident_locked flag on transactions ─────────────────────────
    const [incidentLockedCol] = await pool.query(
      `SELECT COUNT(*) AS column_count
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME   = 'transactions'
         AND COLUMN_NAME  = 'incident_locked'`,
      [process.env.DB_NAME]
    );
    if ((incidentLockedCol[0]?.column_count || 0) === 0) {
      await pool.query(
        `ALTER TABLE transactions
         ADD COLUMN incident_locked TINYINT(1) NOT NULL DEFAULT 0 AFTER fine_paid`
      );
      console.log('Migrated transactions.incident_locked column');
    }

    // ── Migration: book_incident_reports table ──────────────────────────────────
    const [irTable] = await pool.query(
      `SELECT COUNT(*) AS table_count
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME   = 'book_incident_reports'`,
      [process.env.DB_NAME]
    );
    if ((irTable[0]?.table_count || 0) === 0) {
      await pool.query(
        `CREATE TABLE book_incident_reports (
           id                   INT(11)       NOT NULL AUTO_INCREMENT,
           transaction_id       INT(11)       NOT NULL,
           reported_by_user_id  VARCHAR(50)   NOT NULL DEFAULT '',
           incident_type        ENUM('Lost','Torn','Damaged','Other') NOT NULL DEFAULT 'Other',
           description          TEXT,
           status               ENUM('Pending','Resolved','Dismissed') NOT NULL DEFAULT 'Pending',
           action_taken         ENUM('Replacement Required','No Action Needed','Dismissed') DEFAULT NULL,
           staff_notes          TEXT,
           resolved_by_user_id  VARCHAR(50)   DEFAULT NULL,
           created_at           DATETIME      DEFAULT CURRENT_TIMESTAMP,
           resolved_at          DATETIME      DEFAULT NULL,
           PRIMARY KEY (id),
           KEY idx_bir_transaction (transaction_id),
           KEY idx_bir_status (status),
           KEY idx_bir_reporter (reported_by_user_id),
           CONSTRAINT fk_bir_transaction
             FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE CASCADE
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
      console.log('Created book_incident_reports table');
    } else {
      // Ensure ENUM includes 'Action Required'
      try {
        await pool.query(
          `ALTER TABLE book_incident_reports
           MODIFY COLUMN status ENUM('Pending','Action Required','Resolved','Dismissed') NOT NULL DEFAULT 'Pending'`
        );
      } catch (e) {
        // Ignored if already up to date
      }

      // Auto-resolve any legacy incident reports that were set to 'Action Required' despite 'No Action Needed'
      try {
        await pool.query(
          `UPDATE book_incident_reports
           SET status = 'Resolved', resolved_at = COALESCE(resolved_at, NOW())
           WHERE action_taken = 'No Action Needed' AND status = 'Action Required'`
        );
      } catch (e) {
        // Ignored
      }
    }

    // ── Migration: ensure sp_checkout_book enforces maximum 3 books limit ───────
    try {
      await pool.query('DROP PROCEDURE IF EXISTS sp_checkout_book');
      await pool.query(`
        CREATE PROCEDURE sp_checkout_book(
            IN p_book_id     INT,
            IN p_borrower_id INT,
            IN p_loan_date   DATE,
            IN p_due_date    DATE,
            IN p_notes       TEXT
        )
        BEGIN
            DECLARE v_copies        INT DEFAULT 0;
            DECLARE v_book_exists   INT DEFAULT 0;
            DECLARE v_borrower_exists INT DEFAULT 0;
            DECLARE v_overdue_count INT DEFAULT 0;
            DECLARE v_active_loans  INT DEFAULT 0;
            DECLARE v_new_id        INT;
            DECLARE EXIT HANDLER FOR SQLEXCEPTION
            BEGIN
                ROLLBACK;
                RESIGNAL;
            END;
            START TRANSACTION;
            -- Validate book exists and has copies
            SELECT COUNT(*), IFNULL(MAX(copies_available), 0)
              INTO v_book_exists, v_copies
              FROM books
              WHERE id = p_book_id;
            IF v_book_exists = 0 THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Book not found';
            END IF;
            IF v_copies <= 0 THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No copies available';
            END IF;
            -- Validate borrower exists
            SELECT COUNT(*) INTO v_borrower_exists FROM borrowers WHERE id = p_borrower_id;
            IF v_borrower_exists = 0 THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Borrower not found';
            END IF;
            -- Check for overdue books
            SELECT COUNT(*) INTO v_overdue_count
              FROM transactions
              WHERE borrower_id = p_borrower_id
                AND status IN ('Loaned', 'Overdue')
                AND due_date < CURDATE();
            IF v_overdue_count > 0 THEN
                SIGNAL SQLSTATE '45000'
                    SET MESSAGE_TEXT = 'This borrower has overdue book(s). All overdue books must be returned before borrowing again.';
            END IF;
            -- Check maximum 3 books limit
            SELECT COUNT(*) INTO v_active_loans
              FROM transactions
              WHERE borrower_id = p_borrower_id
                AND status IN ('Loaned', 'Overdue');
            IF v_active_loans >= 3 THEN
                SIGNAL SQLSTATE '45000'
                    SET MESSAGE_TEXT = 'Borrower has reached the maximum borrowing limit of 3 books. Please return a book before borrowing again.';
            END IF;
            -- Create the transaction
            INSERT INTO transactions (book_id, borrower_id, loan_date, due_date, notes, status)
            VALUES (
                p_book_id,
                p_borrower_id,
                IFNULL(p_loan_date, CURDATE()),
                p_due_date,
                IFNULL(p_notes, ''),
                'Loaned'
            );
            SET v_new_id = LAST_INSERT_ID();
            -- Decrement available copies
            UPDATE books
            SET copies_available = copies_available - 1
            WHERE id = p_book_id;
            -- Return the created transaction with joined data
            SELECT
                t.*,
                b.title   AS book_title,
                b.barcode AS book_barcode,
                CONCAT(br.firstname, ' ', br.lastname) AS borrower_name
            FROM transactions t
            INNER JOIN books b      ON t.book_id     = b.id
            INNER JOIN borrowers br ON t.borrower_id = br.id
            WHERE t.id = v_new_id;
            COMMIT;
        END
      `);
      console.log('Migrated sp_checkout_book procedure (enforcing 3 books maximum limit)');
    } catch (procErr) {
      console.warn('Note: sp_checkout_book procedure migration skipped or handled by app:', procErr.message);
    }
  } catch (err) {
    console.error('MySQL connection failed:', err.message);
    process.exit(1);
  }

}

module.exports = { getDb, initializeDatabase };
