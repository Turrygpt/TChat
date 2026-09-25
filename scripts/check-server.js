const { createWidgetServer } = require('../src/server/widgetServer');

const server = createWidgetServer({ port: Number(process.env.TCHAT_PORT || 3000) });

async function check() {
  try {
    const status = await server.start();
    console.log(`Проверочный сервер запущён: ${status.url}`);
    const health = await fetch(`${status.url}/health`);
    const payload = await health.json();
    if (!health.ok || !payload.ok) throw new Error('/health не отвечает');
    console.log(`Проверка здоровья сервера: ${payload.message}`);

    const remote = await fetch(`${status.url}/widgets/remote.html`);
    if (!remote.ok) throw new Error('удалённая панель недоступна');
    const update = await fetch(`${status.url}/goal/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Проверка', target: 1000, current: 25 }),
    });
    const updated = await update.json();
    const state = await (await fetch(`${status.url}/goal/state`)).json();
    if (!update.ok || updated.goal?.current !== 25 || state.current !== 25) {
      throw new Error('удалённая панель не сохраняет состояние сбора');
    }
    console.log('Проверка удалённой панели: страница и управление сбором работают.');
  } catch (error) {
    console.error(`Проверка сервера завершилась ошибкой: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await server.stop();
    console.log('Проверочный сервер остановлён.');
  }
}

check();
