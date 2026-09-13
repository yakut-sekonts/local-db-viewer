/** Trino Hive rejects table formats served by a different connector. */
export function tableFormatError(message: string): string | undefined {
  const format = /Cannot query (Iceberg|Delta Lake|Hudi) table/i.exec(message)?.[1];
  if (format) return `Trino сообщает, что текущий connector не может читать ${format}-таблицу. Выберите каталог с подходящим connector. Если такого каталога нет, требуется настройка на стороне Trino.`;
  if (/Not a Hive table/i.test(message)) return 'Таблица не относится к Hive. Проверьте каталог и connector в Trino.';
}
