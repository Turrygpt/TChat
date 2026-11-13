'use strict';
const { makeHistoryBank } = require('./history-bank');
const { makeLoreBank } = require('./lore-bank');
const { characters } = require('./characters');
const { refreshHistoryBank } = require('./history-refresh');
const legacyHistory = makeHistoryBank();
const questions = [...refreshHistoryBank(legacyHistory), ...makeLoreBank()];
// Old reserved schedules remain loadable when a saved evening spans an update.
const questionById = new Map([...legacyHistory, ...questions].map(item => [item.id, item]));
const pointSteps = [100, 200, 300, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 125000, 250000, 500000, 1000000];
if (new Set(questions.map(item => item.id)).size !== questions.length) throw new Error('Duplicate quiz question IDs.');
module.exports = { questions, questionById, pointSteps, characters };
