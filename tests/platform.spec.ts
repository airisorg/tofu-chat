import {
  expect,
  test,
  captureBeforeNavigation,
  type Page,
  type Browser,
  type Locator,
} from './coverage-test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

// These are local engine/layout simulations, not claims of physical iPhone or
// installed Safari testing. UA/standalone/visualViewport mocks exercise real UI
// branches without visiting production or requesting OAuth/microphone access.
const main = (page: Page) => page.getByRole('main');
test('phone actions retain usable touch targets', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    await page.route('**/api/config', (route) =>
      route.fulfill({
        json: {
          supabaseUrl: '',
          supabaseAnonKey: '',
          databaseConfigured: false,
        },
      }),
    );
    await page.goto(baseURL!);
    await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
    await page.locator('.app-shell').waitFor();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const all = main(page)
      .locator('.home-header')
      .getByRole('button', { name: 'More Home actions', exact: true });
    await expect(all).toBeVisible();
    const allBox = await all.boundingBox();
    expect(allBox!.width).toBeGreaterThanOrEqual(44);
    expect(allBox!.height).toBeGreaterThanOrEqual(44);
    await openDesign(page, true);
    const addPeople = main(page)
      .locator('.conversation-intro')
      .getByRole('button', { name: 'Add people', exact: true });
    await expect(addPeople).toBeVisible();
    const addBox = await addPeople.boundingBox();
    expect(addBox!.width).toBeGreaterThanOrEqual(44);
    expect(addBox!.height).toBeGreaterThanOrEqual(44);
    await addPeople.click();
    const invitation = page.getByRole('dialog', {
      name: 'Add people',
      exact: true,
    });
    await expect(invitation).toBeVisible();
    await expect(invitation.getByRole('textbox', { name: /Email/ })).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
});
async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function noOverflow(page: Page) {
  const size = await page.evaluate(() => ({
    width: innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(size.doc).toBeLessThanOrEqual(size.width + 1);
  expect(size.body).toBeLessThanOrEqual(size.width + 1);
}

async function readable(controls: Locator) {
  const samples = await controls.evaluateAll((nodes) =>
    nodes
      .filter((n) => n.getBoundingClientRect().width > 0 && !n.matches(':disabled'))
      .flatMap((n) => {
        let parent: Element | null = n;
        let background = '';
        while (parent) {
          const color = getComputedStyle(parent).backgroundColor;
          if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
            background = color;
            break;
          }
          parent = parent.parentElement;
        }
        const label = n.getAttribute('aria-label') || n.textContent?.trim() || n.tagName;
        const samples = [{ label, foreground: getComputedStyle(n).color, background }];
        if (n.matches('input[placeholder], textarea[placeholder]'))
          samples.push({
            label: `${label} placeholder`,
            foreground: getComputedStyle(n, '::placeholder').color,
            background,
          });
        return samples;
      }),
  );
  expect(samples.length, 'contrast checks must cover visible controls').toBeGreaterThan(0);
  const luminance = (color: string) => {
    const rgb = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        const channel = v / 255;
        return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
      });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  for (const sample of samples) {
    const a = luminance(sample.foreground),
      b = luminance(sample.background);
    expect(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      `${sample.label}: ${sample.foreground} on ${sample.background}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
}
async function openDesign(page: Page, compact: boolean) {
  if (compact) {
    await main(page)
      .getByRole('button', { name: /Design team/ })
      .first()
      .click();
  } else {
    await page
      .getByRole('complementary', { name: 'Chat navigation' })
      .getByRole('button', { name: 'Design team', exact: true })
      .click();
  }
  await expect(main(page).getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}
const sizes = [
  {
    name: 'small phone portrait',
    width: 320,
    height: 568,
    touch: true,
    compact: true,
  },
  {
    name: 'phone portrait',
    width: 390,
    height: 844,
    touch: true,
    compact: true,
  },
  {
    name: 'phone landscape',
    width: 844,
    height: 390,
    touch: true,
    compact: true,
  },
  {
    name: 'tablet portrait',
    width: 834,
    height: 1112,
    touch: true,
    compact: false,
  },
  {
    name: 'tablet landscape',
    width: 1024,
    height: 768,
    touch: true,
    compact: false,
  },
  { name: 'desktop', width: 1440, height: 960, touch: false, compact: false },
];
for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
      isMobile: size.compact,
    });
    test('layout, typing, sending and focus-trapped details work', async ({ page }) => {
      await demo(page);
      await noOverflow(page);
      if (size.compact) {
        await expect(main(page).getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
        await expect(page.locator('.sidebar')).toBeHidden();
        await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
      } else
        await expect(page.getByRole('complementary', { name: 'Chat navigation' })).toBeVisible();
      await openDesign(page, size.compact);
      await noOverflow(page);
      const input = main(page).getByRole('textbox', {
        name: 'Message',
        exact: true,
      });
      const text = `${size.name} interaction works`;
      await input.fill(text);
      await main(page).getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(main(page).getByRole('article').filter({ hasText: text })).toBeVisible();
      const bounds = await input.boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height + 1);
      if (size.compact)
        expect(
          await input.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
        ).toBeGreaterThanOrEqual(16);
      if (size.touch) {
        const dimensions = await page
          .locator('.conversation-header .icon-button')
          .evaluateAll((nodes) =>
            nodes
              .filter((n) => getComputedStyle(n).display !== 'none')
              .map((n) => ({
                width: n.getBoundingClientRect().width,
                height: n.getBoundingClientRect().height,
              })),
          );
        for (const d of dimensions) {
          expect(d.width).toBeGreaterThanOrEqual(44);
          expect(d.height).toBeGreaterThanOrEqual(44);
        }
      }
      const details = page.getByRole('button', {
        name: 'Conversation details',
        exact: true,
      });
      await details.click();
      const dialog = page.getByRole('dialog', {
        name: 'Design team',
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((n) => n.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((n) => n.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(details).toBeFocused();
      if (size.touch && !size.compact) {
        await page
          .getByRole('banner')
          .getByRole('button', { name: 'Settings', exact: true })
          .click();
        const appearance = page
          .getByRole('dialog')
          .getByRole('combobox', { name: 'Appearance', exact: true });
        expect((await appearance.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'New chat', exact: true }).click();
        const targets = await page
          .getByRole('dialog')
          .locator('.dialog-footer>button')
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        expect(targets.length).toBe(2);
        for (const height of targets) expect(height).toBeGreaterThanOrEqual(44);
        await page.keyboard.press('Escape');
      }
      await noOverflow(page);
    });
  });
}

const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('sign-in landing identifies iPhone, Android and desktop without entering a workspace', async ({
  browser,
  baseURL,
}) => {
  for (const device of [
    { ua: iphone, label: 'Made for iPhone and iPad', mobile: true },
    {
      ua: 'Mozilla/5.0 (Linux; Android 17; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
      label: 'Made for Android',
      mobile: true,
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      label: 'Works in your browser',
      mobile: false,
    },
  ]) {
    const context = await browser.newContext({
      baseURL,
      userAgent: device.ua,
      viewport: device.mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    try {
      const page = await context.newPage();
      await page.goto('/');
      const benefits = page.locator('.welcome-benefits');
      await expect(benefits).toContainText(device.label);
      if (!device.label.includes('iPhone')) await expect(benefits).not.toContainText('iPhone');
      if (!device.label.includes('Android')) await expect(benefits).not.toContainText('Android');
      await expect(
        page.getByRole('button', { name: 'Continue with Google', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.app-shell')).toHaveCount(0);
      await expect(page.locator('.welcome-header .brand')).toBeVisible();
      const help = page.getByRole('button', {
        name: 'Add to Home Screen',
        exact: true,
      });
      await expect(help).toBeVisible();
      if (device.mobile) {
        expect((await help.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(
          await page
            .locator('.welcome-copy > p')
            .first()
            .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
        ).toBeGreaterThanOrEqual(16);
      }
      await help.click();
      const installation = page.getByRole('dialog', {
        name: 'Make yourself at home',
        exact: true,
      });
      await expect(installation).toBeVisible();
      if (device.label.includes('iPhone')) await expect(installation).toContainText('Safari');
      if (device.label.includes('Android'))
        await expect(installation).toContainText('Android Home Screen');
      await page.keyboard.press('Escape');
      await expect(installation).toHaveCount(0);
      await expect(help).toBeFocused();
      await noOverflow(page);
    } finally {
      await context.close();
    }
  }
});

async function installPage(
  browser: Browser,
  baseURL: string | undefined,
  ua: string,
  installed = false,
  ipad = false,
) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: ua,
  });
  if (installed)
    await context.addInitScript(() =>
      Object.defineProperty(navigator, 'standalone', {
        value: true,
        configurable: true,
      }),
    );
  if (ipad)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      });
    });
  const page = await context.newPage();
  await demo(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'More', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'More in Chat', exact: true })
    .getByRole('button', { name: 'Add to Home Screen', exact: true })
    .click();
  return {
    context,
    page,
    dialog: page.getByRole('dialog', {
      name: 'Make yourself at home',
      exact: true,
    }),
  };
}

test('installation help distinguishes iPhone Safari, other iOS browsers, iPad and installed mode', async ({
  browser,
  baseURL,
}) => {
  for (const variant of [
    { ua: iphone, installed: false, ipad: false },
    {
      ua: iphone.replace('Version/18.0', 'CriOS/130.0'),
      installed: false,
      ipad: false,
    },
    {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      installed: false,
      ipad: true,
    },
    { ua: iphone, installed: true, ipad: false },
  ]) {
    const { context, dialog } = await installPage(
      browser,
      baseURL,
      variant.ua,
      variant.installed,
      variant.ipad,
    );
    try {
      if (variant.installed) {
        await expect(
          dialog.getByRole('heading', {
            name: 'You’re using the installed app',
          }),
        ).toBeVisible();
        await expect(dialog.getByText('Add to Home Screen', { exact: true })).toHaveCount(0);
      } else {
        await expect(dialog.getByText('Safari', { exact: true })).toBeVisible();
        await expect(dialog.getByText('Add to Home Screen', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Install Chat', exact: true })).toHaveCount(
          0,
        );
      }
    } finally {
      await context.close();
    }
  }
});

test('desktop and Android installation instructions match their platform', async ({
  browser,
  baseURL,
}) => {
  const desktop = await browser.newContext({
    baseURL,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
  });
  const page = await desktop.newPage();
  await demo(page);
  await page.getByRole('button', { name: 'Help and installation', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Help and support', exact: true })
    .getByRole('button', { name: 'Add to Home Screen', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Make yourself at home',
    exact: true,
  });
  await expect(dialog.getByText('Chrome', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Edge', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Safari', { exact: true })).toHaveCount(0);
  await desktop.close();
  const android = await installPage(
    browser,
    baseURL,
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
  );
  await expect(android.dialog.getByText('Install app', { exact: true })).toBeVisible();
  await expect(android.dialog.getByText('Add to Home screen', { exact: true })).toBeVisible();
  await android.context.close();
});

test.describe('visual viewport and storage resilience', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  test('visual viewport keyboard resize keeps composer reachable and pinch zoom preserves layout', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), {
        height: 844,
        width: 390,
        scale: 1,
        offsetTop: 0,
        offsetLeft: 0,
      });
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: viewport,
      });
      (
        window as unknown as {
          testViewport: (height: number, scale: number) => void;
        }
      ).testViewport = (height, scale) => {
        viewport.height = height;
        viewport.scale = scale;
        viewport.dispatchEvent(new Event('resize'));
      };
    });
    await demo(page);
    await openDesign(page, true);
    const input = main(page).getByRole('textbox', {
      name: 'Message',
      exact: true,
    });
    await input.fill('Keyboard viewport acceptance');
    await input.focus();
    await page.evaluate(() =>
      (
        window as unknown as {
          testViewport: (height: number, scale: number) => void;
        }
      ).testViewport(460, 1),
    );
    await expect
      .poll(async () => {
        const b = await main(page)
          .getByRole('button', { name: 'Send message', exact: true })
          .boundingBox();
        return b!.y + b!.height;
      })
      .toBeLessThanOrEqual(461);
    await main(page).getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      main(page).getByRole('article').filter({ hasText: 'Keyboard viewport acceptance' }),
    ).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as {
          testViewport: (height: number, scale: number) => void;
        }
      ).testViewport(422, 2),
    );
    await expect
      .poll(() => page.locator('.app-shell').evaluate((n) => n.getBoundingClientRect().height))
      .toBe(844);
    await noOverflow(page);
  });
  test('blocked local storage does not crash the app or appearance settings', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => {
          throw new DOMException('Storage blocked', 'SecurityError');
        },
      });
    });
    await demo(page);
    await expect(main(page).getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'More', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'More in Chat', exact: true })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
    expect(failures).toEqual([]);
  });
});

test('dark theme keeps navigation, brand and composer controls readable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('relay-theme', 'dark'));
  await demo(page);
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
  await readable(
    page.locator(
      '.brand, .nav-item, .new-chat-button, .sidebar-conversation.selected, .composer-controls>.icon-button, .conversation-header-actions>.icon-button',
    ),
  );
});

test('dark mode keeps all new-chat modes, forms, menus, recording errors and destructive controls readable', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('relay-theme', 'dark'));
  await demo(page);
  const forms =
    'h2, label, input, textarea, select, small, .dialog-note, .kind-tabs>button, [aria-label="Conversation actions"]>button, .text-button, .primary-button, .icon-button';
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  let dialog = page.getByRole('dialog');
  for (const mode of ['Direct message', 'Group', 'Space']) {
    if (mode !== 'Direct message')
      await dialog
        .getByRole('button', {
          name: mode === 'Group' ? 'Start a group' : 'Create a space',
          exact: true,
        })
        .click();
    await expect(dialog.locator('.kind-tabs')).toHaveCount(0);
    if (mode !== 'Direct message')
      await expect(
        dialog.getByRole('textbox', {
          name: mode === 'Group' ? 'Group name optional' : 'Space name',
          exact: true,
        }),
      ).toBeVisible();
    await readable(dialog.locator(forms));
    const field = dialog.locator('input').first();
    await field.fill('Dark mode typing');
    await field.focus();
    await readable(field);
    const recipient = dialog.getByRole('combobox', {
      name: /^(To|Add people)/,
    });
    await recipient.fill('Maya');
    await expect(dialog.getByRole('listbox', { name: 'Suggested people' })).toBeVisible();
    await readable(
      dialog.locator('[role="option"], [role="option"] strong, [role="option"] small'),
    );
    await recipient.fill('unknown-recipient');
    await dialog
      .getByRole('button', {
        name: mode === 'Space' ? 'Create space' : 'Start chat',
        exact: true,
      })
      .click();
    await expect(dialog.getByRole('alert')).toContainText('complete email address');
    await readable(dialog.getByRole('alert'));
    await noOverflow(page);
    await recipient.fill('');
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  dialog = page.getByRole('dialog');
  await readable(dialog.locator(forms));
  await expect(dialog.getByRole('combobox', { name: 'Appearance' })).toHaveValue('dark');
  await page.keyboard.press('Escape');
  await page.getByRole('banner').getByRole('button', { name: 'Your profile', exact: true }).click();
  const profile = page.getByRole('dialog', { name: 'Your profile', exact: true });
  await expect(profile.locator('[aria-label="Status presets"] > button')).toHaveCount(3);
  await expect(profile.locator('strong')).toHaveCount(1);
  await readable(profile.locator(`${forms}, [aria-label="Status presets"] > button, strong`));
  await page.keyboard.press('Escape');

  await openDesign(page, false);
  const composer = main(page).getByRole('textbox', {
    name: 'Message',
    exact: true,
  });
  await composer.fill('Dark-mode interaction acceptance');
  const send = main(page).getByRole('button', {
    name: 'Send message',
    exact: true,
  });
  await send.hover();
  await readable(
    main(page).locator(
      '.composer textarea, .composer-controls>.icon-button, .send-button, .composer-hint',
    ),
  );
  await send.click();
  const ownMessage = main(page)
    .getByRole('article')
    .filter({ hasText: 'Dark-mode interaction acceptance' });
  await ownMessage.hover();
  await ownMessage.getByRole('button', { name: 'More actions', exact: true }).click();
  await readable(page.getByRole('dialog').locator('h2, .menu-list>button, .icon-button'));
  await page.getByRole('dialog').getByRole('button', { name: 'Edit message', exact: true }).click();
  await readable(page.getByRole('dialog').locator(forms));
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Dark-mode message edited');
  const save = page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true });
  await save.hover();
  await readable(save);
  await save.click();
  const editedMessage = main(page)
    .getByRole('article')
    .filter({ hasText: 'Dark-mode message edited' });
  await editedMessage.hover();
  await editedMessage.getByRole('button', { name: 'More actions', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete message', exact: true })
    .click();
  await readable(page.getByRole('dialog').locator('h2, .dialog-note, .delete-preview, button'));
  const deleteButton = page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete message', exact: true });
  await deleteButton.hover();
  await readable(deleteButton);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Conversation details', exact: true }).click();
  await readable(
    page
      .getByRole('dialog')
      .locator(
        'h2, h3, .menu-list>button, .dialog-note, .member-list strong, .member-list small, .icon-button',
      ),
  );
  await page.keyboard.press('Escape');
  await editedMessage.hover();
  await editedMessage.getByRole('button', { name: 'Reply in thread', exact: true }).click();
  await readable(page.locator('.thread-panel').locator('h2, textarea, .icon-button, .send-button'));
  await page.getByRole('button', { name: 'Close thread', exact: true }).click();

  // Reject microphone access locally so the actual recorder error is rendered;
  // this never requests or grants operating-system microphone permission.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException('Denied for test', 'NotAllowedError');
        },
      },
    });
    if (typeof MediaRecorder === 'undefined')
      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        value: class {},
      });
  });
  await page.getByRole('button', { name: 'Record voice note', exact: true }).click();
  dialog = page.getByRole('dialog');
  await readable(dialog.locator('h2, p, small, button'));
  await dialog.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Microphone access was denied');
  await readable(dialog.locator('h2, p, small, button'));
  await page.keyboard.press('Escape');
  await noOverflow(page);
});

test.describe('landscape keyboard contraction', () => {
  test.use({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  });
  test('composer remains reachable in a 190px visual viewport', async ({ page }) => {
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), {
        height: 390,
        width: 844,
        scale: 1,
        offsetTop: 0,
        offsetLeft: 0,
      });
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: viewport,
      });
      (window as unknown as { contractViewport: () => void }).contractViewport = () => {
        viewport.height = 190;
        viewport.dispatchEvent(new Event('resize'));
      };
    });
    await demo(page);
    await openDesign(page, true);
    await main(page)
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Landscape keyboard message');
    await page.evaluate(() =>
      (window as unknown as { contractViewport: () => void }).contractViewport(),
    );
    const send = main(page).getByRole('button', {
      name: 'Send message',
      exact: true,
    });
    await expect
      .poll(async () => {
        const box = await send.boundingBox();
        return box!.y + box!.height;
      })
      .toBeLessThanOrEqual(191);
    await send.click();
    await expect(
      main(page).getByRole('article').filter({ hasText: 'Landscape keyboard message' }),
    ).toBeVisible();
    await noOverflow(page);
  });
});

for (const signInInput of ['click', 'Enter'] as const) {
  test(`installed-mode Google sign-in derives the broker return from this app origin via ${signInInput}`, async ({
    page,
    baseURL,
  }) => {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'standalone', {
        configurable: true,
        value: true,
      }),
    );
    await page.route('**/api/config', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          supabaseUrl: 'https://auth.example.test',
          supabaseAnonKey: 'public-test-key',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        }),
      }),
    );
    let broker = '';
    // This intercepts the outbound navigation. It never contacts Tofu or Google
    // and does not establish Safari's physical standalone-context behavior.
    await page.route('https://sign-in.example.test/start?*', (route) => {
      broker = route.request().url();
      return route.fulfill({
        contentType: 'text/html',
        body: '<p>Intercepted sign-in navigation</p>',
      });
    });
    await page.goto('/');
    const signIn = page.getByRole('button', {
      name: 'Continue with Google',
      exact: true,
    });
    await expect(signIn).toBeEnabled();
    await captureBeforeNavigation(page);
    if (signInInput === 'click') await signIn.click();
    else await signIn.press('Enter');
    await expect.poll(() => broker).not.toBe('');
    const url = new URL(broker);
    expect(url.origin + url.pathname).toBe('https://sign-in.example.test/start');
    const callback = new URL(url.searchParams.get('return')!);
    expect(callback.origin).toBe(new URL(baseURL!).origin);
    expect(callback.pathname).toBe('/');
    expect(callback.hash).toBe('');
    expect(callback.searchParams.get('chat_login_nonce')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect([...callback.searchParams.keys()]).toEqual(['chat_login_nonce']);
  });
}

for (const signInUrl of [
  undefined,
  '',
  'http://sign-in.example.test/start',
  'https://user:pw@sign-in.example.test/start',
]) {
  test(`Google sign-in stays off with no usable host sign-in address (${String(signInUrl)})`, async ({
    page,
  }) => {
    await page.route('**/api/config', (route) =>
      route.fulfill({
        json: {
          supabaseUrl: 'https://auth.example.test',
          supabaseAnonKey: 'public-test-key',
          databaseConfigured: true,
          ...(signInUrl === undefined ? {} : { signInUrl }),
        },
      }),
    );
    const starts: string[] = [];
    // No address is built into the app, so no sign-in navigation may leave this origin.
    await page.route(/\/start\?/, (route) => {
      starts.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    await page.goto('/');
    const signIn = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await expect(signIn).toBeDisabled();
    await expect(page.locator('.auth-note')).toHaveText(
      /Google sign-in is (being configured|temporarily unavailable)/,
    );
    expect(starts).toEqual([]);
  });
}

test('real M4A picker alias sends as canonical MP4 audio, decodes and survives reload', async ({
  page,
}) => {
  const fixture = readFileSync(resolve(process.cwd(), 'tests/fixtures/picker-tone.m4a'));
  expect(fixture.subarray(4, 8).toString('ascii')).toBe('ftyp');
  await demo(page);
  await openDesign(page, false);
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'picker-tone.m4a',
    mimeType: 'audio/x-m4a',
    buffer: fixture,
  });
  await expect(
    main(page).getByRole('button', {
      name: 'Remove picker-tone.m4a',
      exact: true,
    }),
  ).toBeVisible();
  await main(page)
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Real picker M4A acceptance');
  await main(page).getByRole('button', { name: 'Send message', exact: true }).click();
  let row = main(page).getByRole('article').filter({ hasText: 'Real picker M4A acceptance' });
  let audio = row.locator('audio');
  await expect(audio).toHaveAttribute('src', /^data:audio\/mp4;base64,/);
  await expect
    .poll(() => audio.evaluate((n) => (n as HTMLAudioElement).duration))
    .toBeGreaterThan(0.9);
  await expect
    .poll(() => audio.evaluate((n) => (n as HTMLAudioElement).duration))
    .toBeLessThan(1.2);
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await openDesign(page, false);
  row = main(page).getByRole('article').filter({ hasText: 'Real picker M4A acceptance' });
  audio = row.locator('audio');
  await expect(audio).toHaveAttribute('src', /^data:audio\/mp4;base64,/);
  await expect(
    row.getByRole('link', { name: 'Download picker-tone.m4a', exact: true }),
  ).toHaveAttribute('download', 'picker-tone.m4a');
});

test('a valid PNG at the 5 MB boundary sends and renders; a larger file is rejected', async ({
  page,
}) => {
  // A real one-pixel PNG with a legal private ancillary chunk reaches the
  // exact file-size boundary without depending on compression or invalid data.
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, bytes: Buffer) => {
    const name = Buffer.from(kind);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([name, bytes])));
    return Buffer.concat([length, name, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const start = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 26, 82, 210]))),
  ]);
  const end = chunk('IEND', Buffer.alloc(0));
  const limit = 5 * 1024 * 1024;
  const image = Buffer.concat([
    start,
    chunk('raNd', Buffer.alloc(limit - start.length - end.length - 12)),
    end,
  ]);
  expect(image.length).toBe(limit);
  await demo(page);
  await openDesign(page, false);
  const picker = page.locator('input[type=file]').first();
  await picker.setInputFiles({
    name: 'too-large.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([image, Buffer.from([0])]),
  });
  await expect(page.getByRole('status')).toContainText('5 MB or smaller');
  await expect(page.getByRole('button', { name: 'Remove too-large.png', exact: true })).toHaveCount(
    0,
  );
  await picker.setInputFiles({
    name: 'five-megabyte.png',
    mimeType: 'image/png',
    buffer: image,
  });
  await expect(
    page.getByRole('button', { name: 'Remove five-megabyte.png', exact: true }),
  ).toBeVisible();
  await main(page)
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Five megabyte image acceptance');
  await main(page).getByRole('button', { name: 'Send message', exact: true }).click();
  const row = main(page).getByRole('article').filter({ hasText: 'Five megabyte image acceptance' });
  const rendered = row.getByRole('img', {
    name: 'five-megabyte.png',
    exact: true,
  });
  await expect(rendered).toBeVisible();
  await expect
    .poll(() => rendered.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(1);
  await rendered.click();
  const preview = page.getByRole('dialog');
  await expect(
    preview.getByRole('link', { name: 'Download original', exact: true }),
  ).toHaveAttribute('download', 'five-megabyte.png');
});

test('protected media shows text immediately, loads with authorization and recovers through Retry', async ({
  page,
  context,
  baseURL,
}) => {
  // Invalid, local-only SDK session and routed APIs exercise the real hook.
  // No real credential, hosted API or identity provider is contacted.
  const userId = '00000000-0000-4000-8000-000000000111';
  const conversationId = '00000000-0000-4000-8000-000000000222';
  const messageId = '00000000-0000-4000-8000-000000000333';
  const authOrigin = 'https://media-fixture.invalid';
  const now = Math.floor(Date.now() / 1000);
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url'),
    'INVALID_LOCAL_TEST_SIGNATURE',
  ].join('.');
  const user = {
    id: userId,
    email: 'media-test@example.invalid',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: 'Local media fixture' },
    created_at: new Date().toISOString(),
  };
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT0sAAAAASUVORK5CYII=',
    'base64',
  );
  const state = {
    user: { id: userId, name: 'Local media fixture', email: user.email },
    conversations: [
      {
        id: conversationId,
        name: 'Protected media fixture',
        kind: 'space',
        members: [{ id: userId, name: 'Local media fixture', email: user.email }],
        unread: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
    messages: [
      {
        id: messageId,
        conversationId,
        author: { id: userId, name: 'Local media fixture', email: user.email },
        text: 'Text is available while the file loads.',
        createdAt: new Date().toISOString(),
        reactions: [],
        attachments: [
          {
            name: 'private-image.png',
            type: 'image/png',
            size: image.length,
            url: `/api/attachments?messageId=${messageId}&index=0`,
          },
        ],
      },
    ],
  };
  await context.addInitScript(
    (session) => {
      localStorage.removeItem('relay-chat-demo-choice-v1');
      localStorage.setItem('relay-chat-auth-v1', JSON.stringify(session));
      localStorage.setItem('relay-theme', 'dark');
    },
    {
      access_token: token,
      refresh_token: 'INVALID_LOCAL_TEST_REFRESH',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + 3600,
      user,
    },
  );
  await page.routeWebSocket(`${authOrigin.replace('https:', 'wss:')}/**`, (socket) =>
    socket.close(),
  );
  let attempts = 0;
  const authorizations: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === authOrigin && url.pathname === '/auth/v1/user')
      return route.fulfill({ json: user });
    if (url.origin !== new URL(baseURL!).origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/config')
      return route.fulfill({
        json: {
          supabaseUrl: authOrigin,
          supabaseAnonKey: 'PUBLIC_LOCAL_FIXTURE_ONLY',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        },
      });
    if (url.pathname === '/api/chat') return route.fulfill({ json: { state } });
    if (url.pathname === '/api/attachments') {
      attempts++;
      authorizations.push(route.request().headers().authorization || '');
      if (attempts === 1) {
        await held;
        return route.fulfill({
          status: 503,
          json: { error: 'Local fixture unavailable' },
        });
      }
      return route.fulfill({ contentType: 'image/png', body: image });
    }
    return route.continue();
  });
  try {
    await page.goto('/');
    await expect(page.locator('.app-shell')).toBeVisible();
    await page
      .getByRole('complementary', { name: 'Chat navigation' })
      .getByRole('button', { name: 'Protected media fixture', exact: true })
      .click();
    const row = main(page)
      .getByRole('article')
      .filter({ hasText: 'Text is available while the file loads.' });
    await expect(row).toBeVisible();
    await expect.poll(() => attempts).toBe(1);
    await expect(row.getByRole('status')).toContainText('Loading attachment');
    await expect(row.locator('img, audio, a[href] ')).toHaveCount(0);
    release();
    const retry = row.getByRole('button', {
      name: 'Retry private-image.png',
      exact: true,
    });
    await expect(retry).toBeVisible();
    await readable(row.locator('strong, small, button'));
    await retry.click();
    const ready = row.getByRole('img', {
      name: 'private-image.png',
      exact: true,
    });
    await expect(ready).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => ready.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(1);
    expect(attempts).toBe(2);
    expect(authorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    await page.getByRole('button', { name: 'Conversation details', exact: true }).click();
    const shared = page
      .getByRole('dialog')
      .getByRole('link', { name: 'private-image.png', exact: true });
    await expect(shared).toHaveAttribute('href', /^blob:/);
    expect(attempts, 'shared files uses the same authenticated cache').toBe(2);
  } finally {
    release();
  }
});
