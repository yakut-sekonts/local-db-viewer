export const CLIPBOARD_BYTES = 16 * 1024 * 1024;

export function validateClipboardText(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('Некорректный текст буфера обмена.');
  if (value.includes('\0')) throw new Error('Текст содержит NUL. Буфер обмена может обрезать его; сохраните результат в CSV.');
  if (value.length > CLIPBOARD_BYTES || new TextEncoder().encode(value).length > CLIPBOARD_BYTES) {
    throw new Error('Текст для копирования превышает 16 MiB. Выделите меньший диапазон.');
  }
}
