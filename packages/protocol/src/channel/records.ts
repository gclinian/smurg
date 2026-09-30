// DATA framing: one application message = one DATA frame = { [u16be len][noise transport message] }+ .
// Record plaintext is [flags][body ≤ 65518]; flags bit 0 = FIN (last record of the message), other bits reserved = 0.
//
// Message boundaries travel INSIDE the ciphertext, so a relay that re-splits or merges WebSocket messages cannot
// change where application messages begin or end. A dropped, replayed, reordered or modified record breaks the
// strict nonce sequence and fails AEAD; every such failure is fatal and the opener stays dead afterwards.
import {
  FRAME_TYPE_BYTES,
  MAX_APP_MESSAGE,
  MAX_RECORD_BODY,
  NOISE_TAG_BYTES,
  RECORD_FLAGS_BYTES,
  RECORD_LENGTH_BYTES,
  RECORD_OVERHEAD_BYTES,
  noiseRecordCount,
} from '../constants.ts';
import { EMPTY_BYTES } from '../bytes.ts';
import { NoiseError } from '../noise/errors.ts';
import type { CipherState } from '../noise/state.ts';
import { ChannelError } from './errors.ts';
import { CHANNEL_FRAME } from './frames.ts';

const FIN = 0x01;
const MIN_RECORD_BYTES = RECORD_FLAGS_BYTES + NOISE_TAG_BYTES;

function assertLimit(maxMessageBytes: number): void {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 0) throw new RangeError('invalid maxMessageBytes');
}

/** Encrypts application messages into DATA frames. After an internal failure it refuses further use. */
export class RecordSealer {
  private readonly cipher: CipherState;
  readonly maxMessageBytes: number;
  private dead = false;

  constructor(cipher: CipherState, maxMessageBytes: number = MAX_APP_MESSAGE) {
    assertLimit(maxMessageBytes);
    this.cipher = cipher;
    this.maxMessageBytes = maxMessageBytes;
  }

  /**
   * Seals one application message into a fresh DATA frame. Throws ChannelError('too-large') without touching the
   * cipher state when the message exceeds the limit (the channel stays usable).
   */
  seal(message: Uint8Array): Uint8Array {
    if (this.dead) throw new ChannelError('closed', 'sealer is dead after a previous failure');
    if (message.length > this.maxMessageBytes) {
      throw new ChannelError('too-large', `application message of ${message.length} bytes exceeds ${this.maxMessageBytes}`);
    }
    try {
      const records = noiseRecordCount(message.length);
      const out = new Uint8Array(FRAME_TYPE_BYTES + records * RECORD_OVERHEAD_BYTES + message.length);
      out[0] = CHANNEL_FRAME.DATA;
      let offset = FRAME_TYPE_BYTES;
      const plaintext = new Uint8Array(RECORD_FLAGS_BYTES + Math.min(MAX_RECORD_BODY, message.length));
      for (let r = 0; r < records; r++) {
        const start = r * MAX_RECORD_BODY;
        const body = message.subarray(start, Math.min(start + MAX_RECORD_BODY, message.length));
        const record = plaintext.subarray(0, RECORD_FLAGS_BYTES + body.length);
        record[0] = r === records - 1 ? FIN : 0;
        record.set(body, RECORD_FLAGS_BYTES);
        const ciphertext = this.cipher.encryptWithAd(EMPTY_BYTES, record);
        out[offset] = ciphertext.length >>> 8;
        out[offset + 1] = ciphertext.length & 0xff;
        out.set(ciphertext, offset + RECORD_LENGTH_BYTES);
        offset += RECORD_LENGTH_BYTES + ciphertext.length;
      }
      plaintext.fill(0);
      return out;
    } catch (cause) {
      // A partially sealed message has consumed nonces: the send direction is unusable from here on.
      this.dead = true;
      throw new ChannelError('protocol', 'sealing failed', { cause });
    }
  }
}

/**
 * Decrypts DATA frames and reassembles application messages. Every completed message is a FRESH buffer of exactly its
 * length (byteOffset 0), so messages never share memory with each other or with the transport's buffers: msgpack
 * `bin` fields decoded from one message alias only that message.
 */
export class RecordOpener {
  private readonly cipher: CipherState;
  readonly maxMessageBytes: number;
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private dead = false;

  constructor(cipher: CipherState, maxMessageBytes: number = MAX_APP_MESSAGE) {
    assertLimit(maxMessageBytes);
    this.cipher = cipher;
    this.maxMessageBytes = maxMessageBytes;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** One DATA frame -> 0..n complete application messages. Any error is fatal and permanent. */
  open(frame: Uint8Array): Uint8Array[] {
    if (this.dead) throw new ChannelError('closed', 'channel is dead after a previous error');
    try {
      return this.openRecords(frame);
    } catch (err) {
      this.dead = true;
      this.parts = [];
      this.partBytes = 0;
      if (err instanceof ChannelError) throw err;
      if (err instanceof NoiseError && err.code === 'decrypt') {
        throw new ChannelError('integrity', 'record failed authentication (tampered, dropped, replayed or reordered)', { cause: err });
      }
      throw new ChannelError('protocol', 'record processing failed', { cause: err });
    }
  }

  private openRecords(frame: Uint8Array): Uint8Array[] {
    if (frame[0] !== CHANNEL_FRAME.DATA) throw new ChannelError('protocol', `unexpected frame type ${frame[0]}`);
    if (frame.length <= FRAME_TYPE_BYTES) throw new ChannelError('protocol', 'DATA frame without records');
    const done: Uint8Array[] = [];
    let offset = FRAME_TYPE_BYTES;
    while (offset < frame.length) {
      if (offset + RECORD_LENGTH_BYTES > frame.length) throw new ChannelError('protocol', 'truncated record header');
      const length = ((frame[offset] as number) << 8) | (frame[offset + 1] as number);
      const start = offset + RECORD_LENGTH_BYTES;
      if (length < MIN_RECORD_BYTES || start + length > frame.length) throw new ChannelError('protocol', 'bad record length');
      const plaintext = this.cipher.decryptWithAd(EMPTY_BYTES, frame.subarray(start, start + length));
      offset = start + length;
      const flags = plaintext[0] as number;
      if ((flags & ~FIN) !== 0) throw new ChannelError('protocol', 'reserved record flags set');
      const body = plaintext.subarray(RECORD_FLAGS_BYTES);
      const fin = (flags & FIN) !== 0;
      // Canonical framing only (what RecordSealer produces): full non-final records, empty only for an empty message.
      if (!fin && body.length !== MAX_RECORD_BODY) throw new ChannelError('protocol', 'short non-final record');
      if (fin && body.length === 0 && this.parts.length > 0) throw new ChannelError('protocol', 'empty final record');
      this.partBytes += body.length;
      if (this.partBytes > this.maxMessageBytes) {
        throw new ChannelError('too-large', `incoming application message exceeds ${this.maxMessageBytes} bytes`);
      }
      this.parts.push(body);
      if (fin) {
        done.push(joinFresh(this.parts, this.partBytes));
        this.parts = [];
        this.partBytes = 0;
      }
    }
    return done;
  }
}

function joinFresh(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
