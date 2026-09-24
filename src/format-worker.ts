import { formatSQL } from './formatSql';
self.onmessage = ({ data }) => {
  try { self.postMessage({ value: formatSQL(data.sql, data.engine, data.style, data.driverId) }); }
  catch (error) { self.postMessage({ error: (error as Error).message }); }
};
