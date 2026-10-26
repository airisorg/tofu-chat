import { expect, test, type Page } from './coverage-test';
import { build } from 'esbuild';
import { componentCoveragePlugins } from './component-bundle';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyDemoAction, createDemoState, DEMO_STORAGE_KEY } from '../src/lib/demo';

// These checks run on an isolated localhost checkout. The audio fixture bundles
// the actual component rather than adding a test route to the production app.
const main = (page: Page) => page.getByRole('main');

async function demo(page: Page) {
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { supabaseUrl: '', supabaseAnonKey: '', databaseConfigured: false } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await expect(
    page.getByRole('complementary').getByRole('button', { name: 'Design team', exact: true }),
  ).toBeVisible();
}
async function openConversation(page: Page, name: string) {
  await page.getByRole('complementary').getByRole('button', { name, exact: true }).click();
  await expect(main(page).getByRole('heading', { name, exact: true })).toBeVisible();
}

for (const mainState of ['another conversation', 'Home'] as const) {
  test(`Mini thread reply opens its original conversation from ${mainState}`, async ({ page }) => {
    await demo(page);
    await openConversation(page, 'Design team');
    await main(page).getByRole('button', { name: 'Open in a pop-up', exact: true }).click();
    const mini = page.getByRole('region', { name: 'Mini conversation: Design team', exact: true });
    await expect(mini).toBeVisible();
    await mini
      .getByRole('textbox', { name: 'Message in pop-up', exact: true })
      .fill('Preserved Design Mini draft');
    if (mainState === 'another conversation') {
      await openConversation(page, 'Maya Chen');
      await main(page)
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill('Preserved unrelated Maya draft');
    } else {
      await page.getByRole('navigation').getByRole('button', { name: 'Home', exact: true }).click();
    }
    const original = mini
      .getByRole('article')
      .filter({ hasText: 'Can we do a quick review this afternoon?' });
    await expect(original).toHaveCount(1);
    const more = original.getByRole('button', { name: 'More actions', exact: true });
    await more.focus();
    await more.press('Enter');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Reply in thread', exact: true })
      .click();
    await expect(mini).toHaveCount(0);
    await expect(
      main(page).getByRole('heading', { name: 'Design team', exact: true }),
    ).toBeVisible();
    const reply = page.getByRole('textbox', { name: 'Reply in thread', exact: true });
    await reply.fill(`Audit reply from ${mainState}`);
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(reply).toHaveValue('');
    const saved = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      DEMO_STORAGE_KEY,
    );
    const sent = saved.messages.filter(
      (message: { text: string }) => message.text === `Audit reply from ${mainState}`,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].conversationId).toBe('demo-design');
    expect(sent[0].parentId).toBe('demo-message-5');
    await page.getByRole('button', { name: 'Close thread', exact: true }).click();
    await main(page).getByRole('button', { name: 'Open in a pop-up', exact: true }).click();
    await expect(mini.getByRole('textbox', { name: 'Message in pop-up', exact: true })).toHaveValue(
      'Preserved Design Mini draft',
    );
    await mini.getByRole('button', { name: 'Close pop-up', exact: true }).click();
    if (mainState === 'another conversation') {
      await openConversation(page, 'Maya Chen');
      await expect(main(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
        'Preserved unrelated Maya draft',
      );
    }
  });
}

test('malformed saved demo data resets to usable examples instead of crashing', async ({
  page,
  context,
}) => {
  const damaged = createDemoState();
  delete (damaged.user as Partial<typeof damaged.user>).name;
  await context.addInitScript(
    ({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state));
      localStorage.setItem('relay-chat-demo-choice-v1', 'yes');
    },
    { key: DEMO_STORAGE_KEY, state: damaged },
  );
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { supabaseUrl: '', supabaseAnonKey: '', databaseConfigured: false } }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('complementary').getByRole('button', { name: 'Design team', exact: true }),
  ).toBeVisible();
  await openConversation(page, 'Design team');
  await expect(main(page).getByRole('article')).toHaveCount(5);
  expect(failures).toEqual([]);
});

test('valid maximum-length invited person and its conversation persist across browser reload', async ({
  page,
  context,
}) => {
  const email = `${'a'.repeat(242)}@example.com`;
  const created = applyDemoAction(createDemoState(), {
    type: 'create',
    kind: 'group',
    name: 'Maximum invitation',
    emails: [email],
  });
  const seeded = applyDemoAction(created.state, {
    type: 'send',
    conversationId: created.id!,
    text: 'Invitation survives browser reload',
  }).state;
  await context.addInitScript(
    ({ key, state }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    },
    { key: DEMO_STORAGE_KEY, state: seeded },
  );
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await demo(page);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(
      page.getByRole('complementary').getByRole('button', { name: 'Design team', exact: true }),
    ).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Home', exact: true }).click();
    await expect(main(page).getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    const conversation = main(page)
      .getByRole('button')
      .filter({ has: page.locator('strong', { hasText: /^Maximum invitation$/ }) });
    await expect(conversation).toHaveCount(1);
    await conversation.click();
    await expect(main(page).getByRole('article')).toHaveCount(1);
    await expect(main(page).getByRole('article')).toContainText(
      'Invitation survives browser reload',
    );
    const saved = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      DEMO_STORAGE_KEY,
    );
    const restored = saved.conversations.find((item: { id: string }) => item.id === created.id);
    expect(
      restored.members.find((member: { email: string }) => member.email === email),
    ).toMatchObject({
      id: `demo-invite-${email}`,
      name: email.split('@')[0],
    });
  }
  expect(failures).toEqual([]);
});

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
for (const theme of ['light', 'dark'] as const) {
  test(`enabled Google sign-in label has readable default and hover contrast in ${theme}`, async ({
    page,
    context,
  }) => {
    await context.addInitScript((value) => localStorage.setItem('relay-theme', value), theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.route('**/api/config', (route) =>
      route.fulfill({
        json: {
          supabaseUrl: 'https://frontend-audit.invalid',
          supabaseAnonKey: 'sb_publishable_LOCAL_NOT_A_REAL_KEY',
          databaseConfigured: true,
          signInUrl: 'https://sign-in.example.test/start',
        },
      }),
    );
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await expect(button).toBeEnabled();
    for (const hover of [false, true]) {
      if (hover) await button.hover();
      await button.evaluate(async (element) => {
        // Flush the newly hovered style and wait for its finite paint transition.
        void getComputedStyle(element).backgroundColor;
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      const colors = await button.evaluate((element) => ({
        color: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      expect(
        contrast(colors.color, colors.background),
        JSON.stringify({ theme, hover, ...colors }),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test('changing the audio source resets both the displayed and native playback speed', async ({
  page,
}) => {
  const data = `data:audio/mp4;base64,${readFileSync(resolve('tests/fixtures/picker-tone.m4a')).toString('base64')}`;
  await page.addInitScript((source) => {
    (window as unknown as { audioFixtureSource: string }).audioFixtureSource = source;
  }, data);
  const built = await build({
    plugins: componentCoveragePlugins(),
    stdin: {
      contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import AudioPlayer from './src/components/AudioPlayer';
        const data = window.audioFixtureSource;
        const replacement = URL.createObjectURL(new Blob([
          Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0))
        ], {type: 'audio/mp4'}));
        function Fixture() {
          const [second, setSecond] = useState(false);
          return <>
            <button onClick={() => setSecond(true)}>Replace audio source</button>
            <AudioPlayer src={second ? replacement : data} name="Local tone" size={10000}/>
          </>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    outdir: 'test-results/audio-fixture',
    define: { 'process.env.NODE_ENV': '"development"' },
    tsconfig: resolve('tsconfig.json'),
  });
  await page.route('**/frontend-audio-audit', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto('/frontend-audio-audit');
  await page.addStyleTag({
    content: built.outputFiles.find((file) => file.path.endsWith('.css'))!.text,
  });
  await page.addScriptTag({
    content: built.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
  });
  const audio = page.locator('audio');
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Play voice message', exact: true }).click();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause voice message', exact: true }).click();
  await page.getByRole('button', { name: 'Playback speed 1×', exact: true }).click();
  await page.getByRole('button', { name: 'Playback speed 1.5×', exact: true }).click();
  expect(await audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(2);
  const originalNode = await audio.elementHandle();
  await page.getByRole('button', { name: 'Replace audio source', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Playback speed 1×', exact: true })).toBeVisible();
  expect(await audio.evaluate((element, original) => element === original, originalNode)).toBe(
    true,
  );
  expect(await audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1);
  await page.getByRole('button', { name: 'Play voice message', exact: true }).click();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0);
});
