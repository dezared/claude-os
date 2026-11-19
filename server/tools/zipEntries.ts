// The files inside a zip archive, read whole from memory: enough for the XML of an xlsx or ods. No zip64, no encryption.
import { inflateRawSync } from 'node:zlib';
import { httpError } from '../memory/util.ts';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
// A small archive can unpack into gigabytes: nothing a viewer reads needs more than this per file, or in all.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

type Entry = { method: number; local: number; compressed: number };
const broken = () => httpError(415, 'a broken zip archive');
const tooLarge = () => httpError(413, 'the archive unpacks too large');

function findEnd(bytes: Buffer): number {
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  throw httpError(415, 'not a zip archive');
}

function unpack(bytes: Buffer, { method, local, compressed }: Entry, room: number): Buffer {
  if (local + 30 > bytes.length) throw broken();
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  if (start + compressed > bytes.length) throw broken();
  const data = bytes.subarray(start, start + compressed);
  if (method === 0) return data;
  if (method !== 8) throw httpError(415, 'unsupported zip compression');
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(1, room) });
  } catch (err) {
    throw (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? tooLarge() : broken();
  }
}

/** Name to a reader of that file's bytes: a file is unpacked only when asked for, and every read counts against one budget. */
export function zipEntries(bytes: Buffer): Map<string, () => Buffer> {
  const end = findEnd(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const out = new Map<string, () => Buffer>();
  let spent = 0;
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== DIRECTORY_ENTRY) throw broken();
    const entry = { method: bytes.readUInt16LE(at + 10), compressed: bytes.readUInt32LE(at + 20), local: bytes.readUInt32LE(at + 42) };
    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    out.set(name, () => {
      const data = unpack(bytes, entry, Math.min(MAX_ENTRY_BYTES, MAX_UNPACKED_BYTES - spent));
      spent += data.length;
      if (spent > MAX_UNPACKED_BYTES) throw tooLarge();
      return data;
    });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return out;
}
