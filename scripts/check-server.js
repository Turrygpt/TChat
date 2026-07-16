const { createWidgetServer } = require('../src/server/widgetServer');

const server = createWidgetServer({ port: Number(process.env.TCHAT_PORT || 3000) });

server
  .start()
  .then((status) => {
    console.log(`Проверочный сервер запущён: ${status.url}`);
    return fetch(`${status.url}/health`);
  })
  .then((response) => response.json())
  .then((payload) => {
    console.log(`Проверка здоровья сервера: ${payload.message}`);
  })
  .finally(async () => {
    await server.stop();
    console.log('Проверочный сервер остановлён.');
  })
  .catch(async (error) => {
    console.error(`Проверка сервера завершилась ошибкой: ${error.message}`);
    await server.stop();
    process.exitCode = 1;
  });
