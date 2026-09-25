import { expect } from '@playwright/test';
export async function confirmExecution(page) {
  const dialog = page.locator('.execute-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Выполнить (запрос|скрипт)$/ }).click();
  await expect(dialog).toHaveCount(0);
}
