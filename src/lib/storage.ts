import type {
  ChatMessageRecord,
  RoomInfo,
  StoredDeviceIdentity,
  VerifiedPeerRecord,
  VerifiedRoomRecord,
} from '../types/chat';

const DB_NAME = 'LokaKirimDB';
const DB_VERSION = 2;

const STORE_IDENTITY = 'identity';
const STORE_MESSAGES = 'messages';
const STORE_FILES = 'files';
const STORE_ROOM_KEYS = 'roomKeys';
const STORE_VERIFIED_PEERS = 'verifiedPeers';
const STORE_VERIFIED_ROOMS = 'verifiedRooms';
const STORE_ROOMS = 'rooms';
const STORE_OUTGOING_QUEUE = 'outgoingQueue';

export interface QueuedOutgoingMessage {
  id: string;
  conversationType: 'room' | 'dm';
  targetId: string;
  text: string;
  timestamp: number;
  hostKey?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
        db.createObjectStore(STORE_IDENTITY, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        msgStore.createIndex('conversationId', 'conversationId', { unique: false });
        msgStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'transferId' });
      }
      if (!db.objectStoreNames.contains(STORE_ROOM_KEYS)) {
        db.createObjectStore(STORE_ROOM_KEYS, { keyPath: 'roomId' });
      }
      if (!db.objectStoreNames.contains(STORE_VERIFIED_PEERS)) {
        db.createObjectStore(STORE_VERIFIED_PEERS, { keyPath: 'peerId' });
      }
      if (!db.objectStoreNames.contains(STORE_VERIFIED_ROOMS)) {
        db.createObjectStore(STORE_VERIFIED_ROOMS, { keyPath: 'roomId' });
      }
      if (!db.objectStoreNames.contains(STORE_ROOMS)) {
        db.createObjectStore(STORE_ROOMS, { keyPath: 'roomId' });
      }
      if (!db.objectStoreNames.contains(STORE_OUTGOING_QUEUE)) {
        const qStore = db.createObjectStore(STORE_OUTGOING_QUEUE, { keyPath: 'id' });
        qStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function txGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function txPut<T>(storeName: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function txGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => reject(req.error);
  });
}

async function txDelete(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDeviceIdentity(): Promise<StoredDeviceIdentity | null> {
  const record = await txGet<{ key: string; value: StoredDeviceIdentity }>(
    STORE_IDENTITY,
    'self'
  );
  return record?.value || null;
}

export async function saveDeviceIdentity(identity: StoredDeviceIdentity): Promise<void> {
  await txPut(STORE_IDENTITY, { key: 'self', value: identity });
}

export async function loadAllMessages(): Promise<ChatMessageRecord[]> {
  const msgs = await txGetAll<ChatMessageRecord>(STORE_MESSAGES);
  return msgs.sort((a, b) => a.timestamp - b.timestamp);
}

export async function saveMessageRecord(msg: ChatMessageRecord): Promise<void> {
  await txPut(STORE_MESSAGES, msg);
}

export async function saveFileBlob(
  transferId: string,
  blob: Blob,
  fileName: string,
  mimeType: string
): Promise<void> {
  await txPut(STORE_FILES, {
    transferId,
    blob,
    fileName,
    mimeType,
    size: blob.size,
    savedAt: Date.now(),
  });
}

export async function getFileBlob(
  transferId: string
): Promise<{ blob: Blob; fileName: string; mimeType: string } | null> {
  const record = await txGet<{
    transferId: string;
    blob: Blob;
    fileName: string;
    mimeType: string;
  }>(STORE_FILES, transferId);
  return record || null;
}

export async function saveRoomKeyRecord(
  roomId: string,
  rawBase64: string,
  safetyCode: string
): Promise<void> {
  await txPut(STORE_ROOM_KEYS, { roomId, rawBase64, safetyCode });
}

export async function loadAllRoomKeyRecords(): Promise<
  { roomId: string; rawBase64: string; safetyCode: string }[]
> {
  return txGetAll(STORE_ROOM_KEYS);
}

export async function saveCachedRooms(rooms: RoomInfo[]): Promise<void> {
  for (const room of rooms) {
    await txPut(STORE_ROOMS, room);
  }
}

export async function loadCachedRooms(): Promise<RoomInfo[]> {
  return txGetAll<RoomInfo>(STORE_ROOMS);
}

export async function loadVerifiedPeers(): Promise<VerifiedPeerRecord[]> {
  return txGetAll<VerifiedPeerRecord>(STORE_VERIFIED_PEERS);
}

export async function saveVerifiedPeer(record: VerifiedPeerRecord): Promise<void> {
  await txPut(STORE_VERIFIED_PEERS, record);
}

export async function removeVerifiedPeer(peerId: string): Promise<void> {
  await txDelete(STORE_VERIFIED_PEERS, peerId);
}

export async function loadVerifiedRooms(): Promise<VerifiedRoomRecord[]> {
  return txGetAll<VerifiedRoomRecord>(STORE_VERIFIED_ROOMS);
}

export async function saveVerifiedRoom(record: VerifiedRoomRecord): Promise<void> {
  await txPut(STORE_VERIFIED_ROOMS, record);
}

export async function removeVerifiedRoom(roomId: string): Promise<void> {
  await txDelete(STORE_VERIFIED_ROOMS, roomId);
}

export async function loadOutgoingQueue(): Promise<QueuedOutgoingMessage[]> {
  const items = await txGetAll<QueuedOutgoingMessage>(STORE_OUTGOING_QUEUE);
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

export async function saveOutgoingQueueItem(item: QueuedOutgoingMessage): Promise<void> {
  await txPut(STORE_OUTGOING_QUEUE, item);
}

export async function removeOutgoingQueueItem(id: string): Promise<void> {
  await txDelete(STORE_OUTGOING_QUEUE, id);
}

export async function clearConversationHistory(
  conversationId: string,
  targetType?: 'room' | 'dm',
  targetId?: string
): Promise<void> {
  const db = await openDb();
  const [allMsgs, allQueued] = await Promise.all([
    loadAllMessages(),
    loadOutgoingQueue(),
  ]);
  const toDelete = allMsgs.filter((m) => m.conversationId === conversationId);
  const queuedToDelete =
    targetType && targetId
      ? allQueued.filter((q) => q.conversationType === targetType && q.targetId === targetId)
      : [];

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MESSAGES, STORE_FILES, STORE_OUTGOING_QUEUE], 'readwrite');
    const msgStore = tx.objectStore(STORE_MESSAGES);
    const fileStore = tx.objectStore(STORE_FILES);
    const queueStore = tx.objectStore(STORE_OUTGOING_QUEUE);
    for (const m of toDelete) {
      msgStore.delete(m.id);
      if (m.file?.transferId) {
        fileStore.delete(m.file.transferId);
      }
    }
    for (const q of queuedToDelete) {
      queueStore.delete(q.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllChatData(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_MESSAGES, STORE_FILES, STORE_OUTGOING_QUEUE], 'readwrite');
    tx.objectStore(STORE_MESSAGES).clear();
    tx.objectStore(STORE_FILES).clear();
    tx.objectStore(STORE_OUTGOING_QUEUE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
