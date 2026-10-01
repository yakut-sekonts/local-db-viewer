// Defaults for the actual driver class, including Universal JDBC profiles.
// Do not infer a property's units from a similarly named option in another driver.
export function connectionTimeoutDefaults(driverClass: string, seconds: number): Record<string, string> {
  switch (driverClass) {
    case 'org.postgresql.Driver': return { connectTimeout: String(seconds), loginTimeout: String(seconds) };
    case 'com.mysql.cj.jdbc.Driver':
    case 'com.mysql.jdbc.Driver':
    case 'org.mariadb.jdbc.Driver': return { connectTimeout: String(seconds * 1000) };
    // SQL Server interprets 0 as its default, not infinite. The IDE's deadline
    // is independent, and its 0 explicitly leaves driver limits in effect.
    case 'com.microsoft.sqlserver.jdbc.SQLServerDriver': return { loginTimeout: String(seconds) };
    case 'com.clickhouse.jdbc.ClickHouseDriver': return { connection_timeout: String(seconds * 1000) };
    default: return {}; // Trino and arbitrary drivers have no common property.
  }
}

// SQL Server URLs use semicolons and brace-escaped values, not a query string.
// A ';loginTimeout=' inside {database;name} must never count as a property.
export function sqlServerUrlPropertyNames(url: string): Set<string> {
  const names = new Set<string>();
  if (!url.startsWith('jdbc:sqlserver://')) return names;
  let offset = url.indexOf(';');
  while (offset >= 0 && offset < url.length) {
    offset++;
    const equal = url.indexOf('=', offset), separator = url.indexOf(';', offset);
    if (equal < 0) break;
    if (separator >= 0 && separator < equal) { offset = separator; continue; }
    names.add(url.slice(offset, equal).trim().toLowerCase());
    offset = equal + 1;
    while (/\s/.test(url[offset] ?? '') && offset < url.length) offset++;
    if (url[offset] === '{') {
      offset++;
      let closed = false;
      while (offset < url.length) {
        if (url[offset++] !== '}') continue;
        if (url[offset] === '}') { offset++; continue; }
        closed = true; break;
      }
      if (!closed) throw new Error('Некорректный JDBC URL SQL Server: незакрытое значение в фигурных скобках.');
    }
    offset = url.indexOf(';', offset);
  }
  return names;
}
