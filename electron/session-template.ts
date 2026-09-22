import type { Connection } from './trino';
import { validateConnection } from './trino';

/** Resolve in the main process; templates and their unused credentials never reach a worker. */
export function sessionTemplate(connection: Connection, purpose: 'console' | 'introspection', requested?: string): Connection {
  const settings = connection.jdbc;
  const id = requested ?? (purpose === 'console' ? settings?.defaultSessionTemplate : settings?.introspectionSessionTemplate) ?? '';
  const template = id ? settings?.sessionTemplates?.find(item => item.id === id) : undefined;
  if (id && !template) throw new Error('Шаблон сессии удалён. Выберите другой шаблон или настройки подключения.');
  if (!settings) return connection;
  const { sessionTemplates: _, defaultSessionTemplate: __, introspectionSessionTemplate: ___, ...jdbc } = settings;
  if (!template) return { ...connection, jdbc, sessionTemplateId: '' };
  const auth = template.authentication;
  const options = Object.fromEntries(Object.entries(template.options ?? {}).filter(([, value]) => value !== undefined));
  // Explicit authentication must not fall back to credentials from another identity in Advanced.
  if (auth) jdbc.properties = Object.fromEntries(Object.entries(jdbc.properties ?? {}).filter(([key]) => !/^(user|username|password|accessToken)$/i.test(key)));
  return validateConnection({ ...connection, sessionTemplateId: id,
    ...(auth ? { user: auth.user, auth: auth.auth, secret: auth.auth === 'none' ? undefined : auth.secret } : {}),
    jdbc: { ...jdbc, driverVersion: template.driverVersion ?? jdbc.driverVersion, driverClass: template.driverClass ?? jdbc.driverClass,
      classpath: template.classpath ?? jdbc.classpath, options: { ...jdbc.options, ...options } },
  });
}
