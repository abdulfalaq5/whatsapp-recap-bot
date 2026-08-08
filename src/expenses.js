import { getDb } from './storage.js';

export function addExpense({ number, amount, category, note }) {
  getDb().prepare(`
    INSERT INTO expenses (number, amount, category, note, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(number, amount, category || null, note || null, Date.now());
}

export function getExpensesByRange(startTimestamp, endTimestamp) {
  return getDb().prepare(`
    SELECT * FROM expenses
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(startTimestamp, endTimestamp);
}

export function getExpenseSummary(startTimestamp, endTimestamp) {
  return getDb().prepare(`
    SELECT COALESCE(category, 'Lainnya') AS category, SUM(amount) AS total, COUNT(*) AS count
    FROM expenses
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(startTimestamp, endTimestamp);
}

export function getExpenseTotal(startTimestamp, endTimestamp) {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
    WHERE timestamp >= ? AND timestamp <= ?
  `).get(startTimestamp, endTimestamp);
  return row?.total || 0;
}

export function deleteExpense(id) {
  return getDb().prepare(`DELETE FROM expenses WHERE id = ?`).run(id);
}
