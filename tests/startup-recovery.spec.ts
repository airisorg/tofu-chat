import { expect, test } from './coverage-test';

// Controlled loopback responses exercise the real boot hook. No provider or
// production account is contacted, and an enabled button is not OAuth proof.
const valid = {
  supabaseUrl: 'https://startup-fixture.invalid',
  supabaseAnonKey: 'sb_publishable_STARTUP_SYNTHETIC',
  databaseConfigured: true,
  signInUrl: 'https://sign-in.example.test/start',
};
const malformed = [
  ['null configuration', null],
  ['missing fields', {}],
  ['wrong URL type', { ...valid, supabaseUrl: 17 }],
  ['wrong key type', { ...valid, supabaseAnonKey: [] }],
  ['wrong database flag', { ...valid, databaseConfigured: 'true' }],
] as const;

test('denied session storage keeps sign-in local and explains how to recover', async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({ json: valid }));
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage) throw new DOMException('Storage denied', 'SecurityError');
      return original.call(this, key, value);
    };
  });
  await page.goto('/');
  const initial = page.url();
  const button = page.getByRole('button', { name: 'Continue with Google', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator('.error-banner')).toContainText('Allow site storage');
  expect(page.url()).toBe(initial);
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(button).toBeEnabled();
});

for (const [name, config] of malformed) {
  test(`startup rejects ${name} and keeps sign-in disabled`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/config', (route) => route.fulfill({ json: config }));
    await page.goto('/');
    await expect(page.locator('.error-banner')).toContainText('Unable to connect');
    await expect(
      page.getByRole('button', { name: 'Continue with Google', exact: true }),
    ).toBeDisabled();
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const [name, config] of [
  ['insecure provider', { ...valid, supabaseUrl: 'http://startup-fixture.invalid' }],
  [
    'embedded provider credentials',
    { ...valid, supabaseUrl: 'https://user:password@startup-fixture.invalid' },
  ],
  ['malformed provider URL', { ...valid, supabaseUrl: 'not-a-url' }],
  ['empty provider key', { ...valid, supabaseAnonKey: '' }],
  ['missing database', { ...valid, databaseConfigured: false }],
] as const) {
  test(`startup refuses ${name} without exposing a workspace`, async ({ page }) => {
    await page.route('**/api/config', (route) => route.fulfill({ json: config }));
    await page.goto('/');
    const signIn = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await expect(signIn).toBeVisible();
    await expect(signIn).toBeDisabled();
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  });
}

for (const failure of ['http', 'html', 'broken-json'] as const) {
  test(`startup ${failure} failure recovers on connectivity change without reload`, async ({
    page,
  }) => {
    let requests = 0;
    await page.route('**/api/config', (route) => {
      requests++;
      if (requests > 1) return route.fulfill({ json: valid });
      return route.fulfill({
        status: failure === 'http' ? 503 : 200,
        contentType: failure === 'html' ? 'text/html' : 'application/json',
        body: failure === 'html' ? '<html>Temporarily unavailable</html>' : '{invalid',
      });
    });
    await page.goto('/');
    await expect(page.locator('.error-banner')).toContainText('Unable to connect');
    const signIn = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await expect(signIn).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(signIn).toBeEnabled();
    await expect(page.locator('.error-banner')).toHaveCount(0);
    // Configuration recovery alone must not open an authenticated workspace.
    await expect(page.locator('.app-shell')).toHaveCount(0);
    expect(requests).toBe(2);
  });
}

test('boot timeout leaves usable guest UI and a later connection can retry', async ({ page }) => {
  let requests = 0;
  await page.clock.install();
  await page.route('**/api/config', async (route) => {
    requests++;
    if (requests > 1) return route.fulfill({ json: valid });
    // An unresolved route models a dropped request; abort is owned by the app.
  });
  await page.goto('/');
  await expect.poll(() => requests).toBe(1);
  await page.clock.fastForward(8_100);
  await expect(page.locator('.error-banner')).toContainText('Unable to connect');
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(requests).toBe(2);
});

test('valid settings do not dismiss an unsolicited sign-in callback warning', async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({ json: valid }));
  await page.goto('/#access_token=UNSOLICITED_SYNTHETIC&refresh_token=NOT_REAL');
  await expect(page.locator('.error-banner')).toContainText(
    'sign-in request could not be verified',
  );
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeEnabled();
  await expect(page).not.toHaveURL(/access_token|refresh_token/);
  await expect(page.locator('.app-shell')).toHaveCount(0);
});
