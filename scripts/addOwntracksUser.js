import 'dotenv/config';
import pino from 'pino';
import { initStorage, closeStorage } from '../src/storage.js';
import { hashPassword, upsertOwnTracksUser } from '../src/owntracks.js';

const logger = pino({ level: 'silent' });

async function main() {
  const [username, password, displayName] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Pemakaian: node scripts/addOwntracksUser.js <username> <password> [nama-tampilan]');
    process.exit(1);
  }

  initStorage(process.env.DB_PATH || './data/chat_history.db', logger);
  const passwordHash = await hashPassword(password);
  upsertOwnTracksUser({ username, passwordHash, displayName: displayName || username });
  closeStorage();

  console.log(`User OwnTracks "${username}" tersimpan (nama: ${displayName || username}).`);
}

main().catch((err) => {
  console.error('Gagal menambah user OwnTracks:', err);
  process.exit(1);
});
