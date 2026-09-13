/** Enforce a byte limit before readline can accumulate an unbounded record. */
export async function* limitLineBytes(source: AsyncIterable<Uint8Array>, maximum: number): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Некорректный лимит строки.');
  let pending = 0;
  for await (const bytes of source) {
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      pending += end - start;
      if (pending > maximum) throw new Error(`Строка ClickHouse превышает ${maximum} bytes.`);
      if (newline < 0) break;
      pending = 0; start = newline + 1;
    }
    yield bytes;
  }
}
