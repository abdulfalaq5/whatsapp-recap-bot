import { getDb } from './storage.js';

const HELP_TEXT = `Command belanja:
• !belanja tambah <item> — tambah item, contoh: "!belanja tambah telur"
• !belanja list — lihat daftar belanja
• !belanja selesai <item> — tandai selesai
• !belanja hapus <item> — hapus item
• !belanja bersih — hapus semua`;

export async function handleShoppingCommand(sock, logger, { msg, groupId, senderNumber, arg }) {
  const lower = (arg || '').trim().toLowerCase();

  if (!lower || lower === 'help') {
    await sock.sendMessage(groupId, { text: HELP_TEXT, quoted: msg });
    return;
  }

  if (lower === 'list' || lower === 'lihat') {
    const items = listShoppingItems();
    if (items.length === 0) {
      await sock.sendMessage(groupId, { text: '🛒 Daftar belanja masih kosong. Tambah: !belanja tambah <item>', quoted: msg });
      return;
    }
    const open = items.filter((i) => !i.done);
    const done = items.filter((i) => i.done);
    const lines = [];
    open.forEach((i, idx) => lines.push(`${idx + 1}. ${i.item}`));
    if (done.length) lines.push('', '— Sudah selesai —', ...done.map((i) => `☑️ ${i.item}`));
    const total = items.reduce((a, b) => a + (b.done ? 0 : 1), 0);
    await sock.sendMessage(groupId, { text: `🛒 *Daftar Belanja* (${total} belum selesai)\n\n${lines.join('\n')}`, quoted: msg });
    return;
  }

  if (lower === 'bersih' || lower === 'clear') {
    clearShoppingList();
    await sock.sendMessage(groupId, { text: '🗑️ Daftar belanja dikosongkan.', quoted: msg });
    return;
  }

  const selesai = lower.match(/^(?:selesai|sudah|hapus|done|centang|check)\s+(.+)$/);
  if (selesai) {
    const item = selesai[1].trim();
    const doneCount = markShoppingDone(item);
    const removed = removeShoppingItem(item);
    if (doneCount > 0) {
      await sock.sendMessage(groupId, { text: `☑️ "${item}" ditandai selesai.`, quoted: msg });
    } else if (removed > 0) {
      await sock.sendMessage(groupId, { text: `🗑️ "${item}" dihapus dari daftar belanja.`, quoted: msg });
    } else {
      await sock.sendMessage(groupId, { text: `Tidak ada item "${item}" di daftar belanja.`, quoted: msg });
    }
    return;
  }

  const tambah = lower.match(/^(?:tambah|add|beli)\s+(.+)$/);
  if (tambah) {
    const item = tambah[1].trim();
    if (!item) return;
    addShoppingItem(item, senderNumber);
    logger.info({ item, senderNumber }, 'Shopping item added');
    await sock.sendMessage(groupId, { text: `🛒 "${item}" ditambahkan ke daftar belanja.`, quoted: msg });
    return;
  }

  await sock.sendMessage(groupId, { text: HELP_TEXT, quoted: msg });
}

export function addShoppingItem(item, addedBy) {
  getDb().prepare(`
    INSERT INTO shopping_list (item, added_by, done, created_at)
    VALUES (?, ?, 0, ?)
  `).run(item, addedBy || null, Date.now());
}

export function listShoppingItems() {
  return getDb().prepare(`
    SELECT * FROM shopping_list ORDER BY done ASC, id DESC
  `).all();
}

export function markShoppingDone(item) {
  const res = getDb().prepare(`
    UPDATE shopping_list SET done = 1, completed_at = ?
    WHERE LOWER(TRIM(item)) = LOWER(TRIM(?)) AND done = 0
  `).run(Date.now(), item);
  return res.changes;
}

export function removeShoppingItem(item) {
  const res = getDb().prepare(`
    DELETE FROM shopping_list WHERE LOWER(TRIM(item)) = LOWER(TRIM(?))
  `).run(item);
  return res.changes;
}

export function clearShoppingList() {
  return getDb().prepare(`DELETE FROM shopping_list`).run();
}
