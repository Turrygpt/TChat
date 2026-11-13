'use strict';
const { dossiers } = require('./history-data');
const { question, numbers } = require('./bank-utils');
const extra = require('./history-extra');

function makeHistoryBank() {
  const bank = [];
  dossiers.forEach((d, index) => {
    const [id, name, country, kind, year, event, count, countLabel, metric, metricLabel, trick, detail, ...sources] = d;
    if (id === 'b17') sources.push('https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/195966/boeing-b-17f-memphis-belle/');
    if (id === 'b29') sources.push('https://www.sacmuseum.org/visit/exhibit/b-29tb-superfortress/');
    if (id === 'missouri') sources.push('https://www.history.navy.mil/browse-by-topic/ships/modern-ships/uss-missouri.html');
    if (id === '25pdr') sources.push('https://collection.nam.ac.uk/detail.php?acc=1985-11-36--160', 'https://collection.nam.ac.uk/detail.php?acc=1975-03-63-7-163');
    if (id === '17pdr') sources.push('https://www.nam.ac.uk/sites/default/files/learning-resource-files/2021-11/LetsTalkTanks-Transcript_FINAL.pdf');
    if (id === 'french75') sources.push('https://shop.theworldwar.org/products/the-french-75-the-75mm-m1897-field-gun-that-revolutionized-modern-artillery');
    const add = (level, text, answer, wrong, explanation, task = false) => bank.push(question(`history-${id}-${level}`, level,
      text, answer, wrong, explanation, { mode: 'history', sources, topic: name, task }));
    add(1, `${name}: что это за историческая техника?`, kind, ['Парусный фрегат', 'Истребитель', 'Полевая пушка', 'Подводная лодка', 'Тяжёлый бомбардировщик'].filter(x => x !== kind), `В этом досье ${name} рассматривается как ${kind.toLowerCase()}.`);
    add(2, `С какой страной связано происхождение или принятие на службу ${name} в данном досье?`, country, ['США', 'Великобритания', 'Германия', 'Франция', 'СССР', 'Российская империя'].filter(x => x !== country), `Страна досье: ${country}. Речь не о национальности каждого конструктора или всех эксплуатантах.`);
    add(3, `${name}: в каком году произошло событие «${event}»?`, year, numbers(year, 10), `Событие досье: ${event}, ${year} год.`);
    add(4, `${name}: какое число указано в справке: «${countLabel}»?`, count, numbers(count, Math.max(1, Math.round(count / 5))), `Музейное значение: ${count} — ${countLabel}.`);
    add(5, `${name}. ${trick[0]}`, trick[1], trick.slice(2), `${trick[1]}. Это особенность именно описанной модели или эпизода.`);
    add(6, `${name}: какое значение указано в справке — «${metricLabel}»?`, metric, numbers(metric, Math.max(1, Math.round(metric / 8))), `Значение из источника: ${metric} — ${metricLabel}.`);
    add(7, `${name}. ${detail[0]}`, detail[1], detail.slice(2), detail[1]);
    extra[id].forEach(([text, answer, ...wrong], offset) => {
      const alternatives = typeof answer === 'number' ? numbers(answer, Math.max(1, Math.round(answer / 9))) : wrong;
      add(offset + 8, `${name}. ${text}`, answer, alternatives, String(answer));
    });
  });
  return bank;
}
module.exports = { makeHistoryBank };
