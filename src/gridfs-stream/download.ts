import { Readable } from 'stream';
import type { AnyError } from '../error';
import type { Document } from '../bson';
import type { FindOptions, Sort } from '../operations/find';
import type { Cursor } from './../cursor/cursor';
import type { Callback } from '../utils';
import type { Collection } from '../collection';
import type { ReadPreference } from '../read_preference';
import type { GridFSBucketWriteStream } from './upload';

/** @public */
export interface GridFSBucketReadStreamOptions {
  sort?: Sort;
  skip?: number;
  /** 0-based offset in bytes to start streaming from */
  start?: number;
  /** 0-based offset in bytes to stop streaming before */
  end?: number;
}

/** @public */
export interface GridFSBucketReadStreamOptionsWithRevision extends GridFSBucketReadStreamOptions {
  /** The revision number relative to the oldest file with the given filename. 0
   * gets you the oldest file, 1 gets you the 2nd oldest, -1 gets you the
   * newest. */
  revision?: number;
}

/** @public */
export interface GridFSFile {
  _id: GridFSBucketWriteStream['id'];
  length: GridFSBucketWriteStream['length'];
  chunkSize: GridFSBucketWriteStream['chunkSizeBytes'];
  md5?: boolean | string;
  filename: GridFSBucketWriteStream['filename'];
  contentType?: GridFSBucketWriteStream['options']['contentType'];
  aliases?: GridFSBucketWriteStream['options']['aliases'];
  metadata?: GridFSBucketWriteStream['options']['metadata'];
  uploadDate: Date;
}

/** @internal */
export interface GridFSBucketReadStreamPrivate {
  bytesRead: number;
  bytesToTrim: number;
  bytesToSkip: number;
  chunks: Collection;
  cursor?: Cursor;
  expected: number;
  files: Collection;
  filter: Document;
  init: boolean;
  expectedEnd: number;
  file?: GridFSFile;
  options: {
    sort?: Sort;
    skip?: number;
    start: number;
    end: number;
  };
  readPreference?: ReadPreference;
}

/**
 * A readable stream that enables you to read buffers from GridFS.
 *
 * Do not instantiate this class directly. Use `openDownloadStream()` instead.
 * @public
 */
export class GridFSBucketReadStream extends Readable {
  /** @internal */
  s: GridFSBucketReadStreamPrivate;

  /**
   * An error occurred
   * @event
   */
  static readonly ERROR = 'error' as const;
  /**
   * Fires when the stream loaded the file document corresponding to the provided id.
   * @event
   */
  static readonly FILE = 'file' as const;
  /**
   * Emitted when a chunk of data is available to be consumed.
   * @event
   */
  static readonly DATA = 'data' as const;
  /**
   * Fired when the stream is exhausted (no more data events).
   * @event
   */
  static readonly END = 'end' as const;
  /**
   * Fired when the stream is exhausted and the underlying cursor is killed
   * @event
   */
  static readonly CLOSE = 'close' as const;

  /** @internal
   * @param chunks - Handle for chunks collection
   * @param files - Handle for files collection
   * @param readPreference - The read preference to use
   * @param filter - The query to use to find the file document
   */
  constructor(
    chunks: Collection,
    files: Collection,
    readPreference: ReadPreference | undefined,
    filter: Document,
    options?: GridFSBucketReadStreamOptions
  ) {
    super();
    this.s = {
      bytesToTrim: 0,
      bytesToSkip: 0,
      bytesRead: 0,
      chunks,
      expected: 0,
      files,
      filter,
      init: false,
      expectedEnd: 0,
      options: {
        start: 0,
        end: 0,
        ...options
      },
      readPreference
    };
  }

  /**
   * Reads from the cursor and pushes to the stream.
   * Private Impl, do not call directly
   */
  _read(): void {
    if (this.destroyed) return;
    waitForFile(this, () => doRead(this));
  }

  /**
   * Sets the 0-based offset in bytes to start streaming from. Throws
   * an error if this stream has entered flowing mode
   * (e.g. if you've already called `on('data')`)
   *
   * @param start - 0-based offset in bytes to start streaming from
   */
  start(start = 0): this {
    throwIfInitialized(this);
    this.s.options.start = start;
    return this;
  }

  /**
   * Sets the 0-based offset in bytes to start streaming from. Throws
   * an error if this stream has entered flowing mode
   * (e.g. if you've already called `on('data')`)
   *
   * @param end - Offset in bytes to stop reading at
   */
  end(end = 0): this {
    throwIfInitialized(this);
    this.s.options.end = end;
    return this;
  }

  /**
   * Marks this stream as aborted (will never push another `data` event)
   * and kills the underlying cursor. Will emit the 'end' event, and then
   * the 'close' event once the cursor is successfully killed.
   *
   * @param callback - called when the cursor is successfully closed or an error occurred.
   */
  abort(callback?: Callback<void>): void {
    this.push(null);
    this.destroyed = true;
    if (this.s.cursor) {
      this.s.cursor.close((error?: Error) => {
        this.emit(GridFSBucketReadStream.CLOSE);
        callback && callback(error);
      });
    } else {
      if (!this.s.init) {
        // If not initialized, fire close event because we will never
        // get a cursor
        this.emit(GridFSBucketReadStream.CLOSE);
      }
      callback && callback();
    }
  }
}

function throwIfInitialized(stream: GridFSBucketReadStream): void {
  if (stream.s.init) {
    throw new Error('You cannot change options after the stream has entered flowing mode!');
  }
}

function doRead(stream: GridFSBucketReadStream): void {
  if (stream.destroyed) return;
  if (!stream.s.cursor) return;
  if (!stream.s.file) return;

  stream.s.cursor.next((error?: Error, doc?: Document) => {
    if (stream.destroyed) {
      return;
    }
    if (error) {
      return __handleError(stream, error);
    }
    if (!doc) {
      stream.push(null);

      process.nextTick(() => {
        if (!stream.s.cursor) return;
        stream.s.cursor.close((error?: Error) => {
          if (error) {
            __handleError(stream, error);
            return;
          }

          stream.emit(GridFSBucketReadStream.CLOSE);
        });
      });

      return;
    }

    if (!stream.s.file) return;

    const bytesRemaining = stream.s.file.length - stream.s.bytesRead;
    const expectedN = stream.s.expected++;
    const expectedLength = Math.min(stream.s.file.chunkSize, bytesRemaining);
    let errmsg: string;
    if (doc.n > expectedN) {
      errmsg = 'ChunkIsMissing: Got unexpected n: ' + doc.n + ', expected: ' + expectedN;
      return __handleError(stream, new Error(errmsg));
    }

    if (doc.n < expectedN) {
      errmsg = 'ExtraChunk: Got unexpected n: ' + doc.n + ', expected: ' + expectedN;
      return __handleError(stream, new Error(errmsg));
    }

    let buf = Buffer.isBuffer(doc.data) ? doc.data : doc.data.buffer;

    if (buf.length !== expectedLength) {
      if (bytesRemaining <= 0) {
        errmsg = 'ExtraChunk: Got unexpected n: ' + doc.n;
        return __handleError(stream, new Error(errmsg));
      }

      errmsg =
        'ChunkIsWrongSize: Got unexpected length: ' + buf.length + ', expected: ' + expectedLength;
      return __handleError(stream, new Error(errmsg));
    }

    stream.s.bytesRead += buf.length;

    if (buf.length === 0) {
      return stream.push(null);
    }

    let sliceStart = null;
    let sliceEnd = null;

    if (stream.s.bytesToSkip != null) {
      sliceStart = stream.s.bytesToSkip;
      stream.s.bytesToSkip = 0;
    }

    const atEndOfStream = expectedN === stream.s.expectedEnd - 1;
    const bytesLeftToRead = stream.s.options.end - stream.s.bytesToSkip;
    if (atEndOfStream && stream.s.bytesToTrim != null) {
      sliceEnd = stream.s.file.chunkSize - stream.s.bytesToTrim;
    } else if (stream.s.options.end && bytesLeftToRead < doc.data.length()) {
      sliceEnd = bytesLeftToRead;
    }

    if (sliceStart != null || sliceEnd != null) {
      buf = buf.slice(sliceStart || 0, sliceEnd || buf.length);
    }

    stream.push(buf);
  });
}

function init(stream: GridFSBucketReadStream): void {
  const findOneOptions: FindOptions = {};
  if (stream.s.readPreference) {
    findOneOptions.readPreference = stream.s.readPreference;
  }
  if (stream.s.options && stream.s.options.sort) {
    findOneOptions.sort = stream.s.options.sort;
  }
  if (stream.s.options && stream.s.options.skip) {
    findOneOptions.skip = stream.s.options.skip;
  }

  stream.s.files.findOne(stream.s.filter, findOneOptions, (error, doc) => {
    if (error) {
      return __handleError(stream, error);
    }

    if (!doc) {
      const identifier = stream.s.filter._id
        ? stream.s.filter._id.toString()
        : stream.s.filter.filename;
      const errmsg = 'FileNotFound: file ' + identifier + ' was not found';
      const err = new Error(errmsg);
      (err as any).code = 'ENOENT';
      return __handleError(stream, err);
    }

    // If document is empty, kill the stream immediately and don't
    // execute any reads
    if (doc.length <= 0) {
      stream.push(null);
      return;
    }

    if (stream.destroyed) {
      // If user destroys the stream before we have a cursor, wait
      // until the query is done to say we're 'closed' because we can't
      // cancel a query.
      stream.emit(GridFSBucketReadStream.CLOSE);
      return;
    }

    try {
      stream.s.bytesToSkip = handleStartOption(stream, doc, stream.s.options);
    } catch (error) {
      return __handleError(stream, error);
    }

    const filter: Document = { files_id: doc._id };

    // Currently (MongoDB 3.4.4) skip function does not support the index,
    // it needs to retrieve all the documents first and then skip them. (CS-25811)
    // As work around we use $gte on the "n" field.
    if (stream.s.options && stream.s.options.start != null) {
      const skip = Math.floor(stream.s.options.start / doc.chunkSize);
      if (skip > 0) {
        filter['n'] = { $gte: skip };
      }
    }
    stream.s.cursor = stream.s.chunks.find(filter).sort({ n: 1 });

    if (stream.s.readPreference) {
      stream.s.cursor.setReadPreference(stream.s.readPreference);
    }

    stream.s.expectedEnd = Math.ceil(doc.length / doc.chunkSize);
    stream.s.file = doc as GridFSFile;

    try {
      stream.s.bytesToTrim = handleEndOption(stream, doc, stream.s.cursor, stream.s.options);
    } catch (error) {
      return __handleError(stream, error);
    }

    stream.emit(GridFSBucketReadStream.FILE, doc);
  });
}

function waitForFile(stream: GridFSBucketReadStream, callback: Callback): void {
  if (stream.s.file) {
    return callback();
  }

  if (!stream.s.init) {
    init(stream);
    stream.s.init = true;
  }

  stream.once('file', () => {
    callback();
  });
}

function handleStartOption(
  stream: GridFSBucketReadStream,
  doc: Document,
  options: GridFSBucketReadStreamOptions
): number {
  if (options && options.start != null) {
    if (options.start > doc.length) {
      throw new Error(
        'Stream start (' +
          options.start +
          ') must not be ' +
          'more than the length of the file (' +
          doc.length +
          ')'
      );
    }
    if (options.start < 0) {
      throw new Error('Stream start (' + options.start + ') must not be ' + 'negative');
    }
    if (options.end != null && options.end < options.start) {
      throw new Error(
        'Stream start (' +
          options.start +
          ') must not be ' +
          'greater than stream end (' +
          options.end +
          ')'
      );
    }

    stream.s.bytesRead = Math.floor(options.start / doc.chunkSize) * doc.chunkSize;
    stream.s.expected = Math.floor(options.start / doc.chunkSize);

    return options.start - stream.s.bytesRead;
  }
  throw new Error('No start option defined');
}

function handleEndOption(
  stream: GridFSBucketReadStream,
  doc: Document,
  cursor: Cursor,
  options: GridFSBucketReadStreamOptions
) {
  if (options && options.end != null) {
    if (options.end > doc.length) {
      throw new Error(
        'Stream end (' +
          options.end +
          ') must not be ' +
          'more than the length of the file (' +
          doc.length +
          ')'
      );
    }
    if (options.start == null || options.start < 0) {
      throw new Error('Stream end (' + options.end + ') must not be ' + 'negative');
    }

    const start = options.start != null ? Math.floor(options.start / doc.chunkSize) : 0;

    cursor.limit(Math.ceil(options.end / doc.chunkSize) - start);

    stream.s.expectedEnd = Math.ceil(options.end / doc.chunkSize);

    return Math.ceil(options.end / doc.chunkSize) * doc.chunkSize - options.end;
  }
  throw new Error('No end option defined');
}

function __handleError(stream: GridFSBucketReadStream, error?: AnyError): void {
  stream.emit(GridFSBucketReadStream.ERROR, error);
}
