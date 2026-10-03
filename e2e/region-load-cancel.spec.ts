import {expect, test, type Page} from '@playwright/test';

test.use({viewport: {width: 1440, height: 1000}});

async function savedRegion(page: Page) {
  await page.goto('/?seed=689856');
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.locator('#region-status')).toContainText('сохранён');
  const saved = await page.evaluate(() => window.__regionEditor!.snapshot());

  await page.getByRole('button', {name: 'Загрузить', exact: true}).click();
  await expect(page.locator('#load-dialog')).toBeVisible();

  return saved;
}

test('cancelled delayed read cannot replace a newly created region', async ({
  page,
}) => {
  await savedRegion(page);
  await page.evaluate(() => {
    const NativeWorker = window.Worker;

    window.Worker = class extends NativeWorker {
      override postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ): void {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'load'
        ) {
          document.body.dataset.staleLoadDispatched = 'true';
        }
        if (Array.isArray(options)) {
          super.postMessage(message, options);
        } else {
          super.postMessage(message, options);
        }
      }
    };

    const original = indexedDB.open.bind(indexedDB);

    indexedDB.open = (...args) => {
      const request = original(...args);

      Object.defineProperty(request, 'onsuccess', {
        set(callback: (event: Event) => void) {
          request.addEventListener('success', event => {
            document.body.dataset.loadReadHeld = 'true';
            window.addEventListener(
              'release-region-read',
              () => {
                const close = request.result.close.bind(request.result);

                request.result.close = () => {
                  close();
                  setTimeout(() => {
                    document.body.dataset.loadReadReleased = 'true';
                  }, 0);
                };

                callback(event);
              },
              {once: true},
            );
          });
        },
      });

      return request;
    };
  });
  await page
    .getByRole('button', {name: 'Открыть сохранение', exact: true})
    .click();
  await expect(page.locator('body')).toHaveAttribute(
    'data-load-read-held',
    'true',
  );
  await page.getByRole('button', {name: 'Закрыть', exact: true}).click();
  await page.getByText('Параметры региона', {exact: true}).click();
  await page.locator('#region-seed').fill('after-cancel');
  await page.getByRole('button', {name: 'Новый регион', exact: true}).click();
  await expect(page.locator('#region')).toHaveAttribute('data-ready', 'true');
  const newer = await page.evaluate(() => window.__regionEditor!.snapshot());

  expect(newer.seed).toBe('after-cancel');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('release-region-read')),
  );
  await expect(page.locator('body')).toHaveAttribute(
    'data-load-read-released',
    'true',
  );
  await expect(page.locator('body')).not.toHaveAttribute(
    'data-stale-load-dispatched',
    'true',
  );
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    newer,
  );
  await expect(page.locator('#region-status')).not.toContainText(
    'восстановлен',
  );
});

test('applying load holds the dialog and game controls until a paused replacement completes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;

    window.Worker = class extends NativeWorker {
      private loadId: unknown = null;
      private released = false;

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (
            typeof event.data !== 'object' ||
            event.data === null ||
            !('id' in event.data) ||
            event.data.id !== this.loadId ||
            this.released
          ) {
            return;
          }

          event.stopImmediatePropagation();
          document.body.dataset.loadApplyHeld = 'true';
          window.addEventListener(
            'release-region-apply',
            () => {
              this.released = true;
              this.dispatchEvent(
                new MessageEvent('message', {data: event.data}),
              );
            },
            {once: true},
          );
        });
      }

      override postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ): void {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'load' &&
          'id' in message
        ) {
          this.loadId = message.id;
        }
        if (Array.isArray(options)) {
          super.postMessage(message, options);
        } else {
          super.postMessage(message, options);
        }
      }
    };
  });
  const saved = await savedRegion(page);

  await page
    .getByRole('button', {name: 'Открыть сохранение', exact: true})
    .click();
  await expect(page.locator('body')).toHaveAttribute(
    'data-load-apply-held',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#load-dialog')).toBeVisible();
  await expect(page.locator('#load-cancel')).toBeDisabled();
  await expect(page.locator('#load-confirm')).toBeDisabled();
  await expect(page.locator('#simulation-toggle')).toBeDisabled();
  await expect(page.locator('#new-region')).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('release-region-apply')),
  );
  await expect(page.locator('#load-dialog')).toBeHidden();
  await expect(
    page.getByRole('button', {name: 'Запустить симуляцию'}),
  ).toBeEnabled();
  await expect(page.locator('#simulation-toggle')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(await page.evaluate(() => window.__regionEditor!.snapshot())).toEqual(
    saved,
  );
});
