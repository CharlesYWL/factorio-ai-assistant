import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const DOS_DATE_1980_01_01 = 0x0021;
const UNIX_FILE_MODE = (0o100644 * 0x10000) >>> 0;
const CRC_TABLE = createCrcTable();

export async function listFiles(directory) {
  const files = [];

  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativeName = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absoluteName = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absoluteName, relativeName);
      } else if (entry.isFile()) {
        files.push(relativeName);
      } else {
        throw new Error(`Archive input must not contain links or special files: ${absoluteName}`);
      }
    }
  }

  await visit(directory, "");
  return files;
}

export async function createDeterministicZip({ cwd, output, files }) {
  const root = path.resolve(cwd);
  const names = [...new Set(files.map(normalizeArchivePath))].sort();
  assert.equal(names.length, files.length, "Archive paths must be unique");
  assert.ok(names.length <= 0xffff, "ZIP32 supports at most 65,535 entries");

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const name of names) {
    const absolutePath = path.resolve(root, ...name.split("/"));
    assert.ok(
      absolutePath.startsWith(`${root}${path.sep}`),
      `Archive path escapes its root: ${name}`,
    );
    const content = await readFile(absolutePath);
    const compressed = deflateRawSync(content, { level: 9 });
    const encodedName = Buffer.from(name, "utf8");
    const checksum = crc32(content);
    assert.ok(content.length <= 0xffffffff, `ZIP32 file is too large: ${name}`);
    assert.ok(compressed.length <= 0xffffffff, `Compressed file is too large: ${name}`);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(encodedName.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, encodedName, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(encodedName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(UNIX_FILE_MODE, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, encodedName);

    localOffset += localHeader.length + encodedName.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, Buffer.concat([...localParts, centralDirectory, end]));
}

export async function readZipEntries(archivePath) {
  const archive = await readFile(archivePath);
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  assert.ok(endOffset >= 0, `${archivePath} has no ZIP end record`);
  assert.ok(endOffset + 22 <= archive.length, `${archivePath} has a truncated ZIP end record`);

  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  assert.ok(
    centralOffset + centralSize <= endOffset,
    `${archivePath} has an invalid central directory`,
  );

  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(
      archive.readUInt32LE(offset),
      CENTRAL_DIRECTORY_HEADER,
      `${archivePath} has an invalid central entry`,
    );
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const contentSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString((flags & UTF8_FLAG) === 0 ? "latin1" : "utf8");
    normalizeArchivePath(name);
    assert.ok(!entries.has(name), `${archivePath} contains duplicate entry ${name}`);

    assert.equal(
      archive.readUInt32LE(localHeaderOffset),
      LOCAL_FILE_HEADER,
      `${archivePath} has an invalid local header for ${name}`,
    );
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const content =
      method === DEFLATE_METHOD
        ? inflateRawSync(compressed)
        : method === 0
          ? Buffer.from(compressed)
          : assert.fail(`Unsupported ZIP compression method ${method} for ${name}`);
    assert.equal(content.length, contentSize, `${name} has an invalid uncompressed size`);
    assert.equal(crc32(content), checksum, `${name} has an invalid CRC-32`);
    entries.set(name, content);

    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, centralOffset + centralSize, `${archivePath} has trailing central data`);
  return entries;
}

function normalizeArchivePath(value) {
  const name = value.replaceAll("\\", "/");
  assert.ok(name.length > 0, "Archive path must not be empty");
  assert.ok(!name.startsWith("/") && !/^[A-Za-z]:/u.test(name), `Absolute archive path: ${name}`);
  assert.ok(
    name.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    `Unsafe archive path: ${name}`,
  );
  return name;
}

function createCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
}

function crc32(content) {
  let value = 0xffffffff;
  for (const byte of content) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
