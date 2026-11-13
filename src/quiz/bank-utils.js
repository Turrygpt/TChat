'use strict';
const crypto = require('node:crypto');

function question(id, level, text, answer, distractors, explanation, extras = {}) {
  const correctText = String(answer);
  const choices = [...new Set([correctText, ...distractors.map(String)])];
  if (choices.length < 4) throw new Error(`Not enough distinct answers: ${id}`);
  const answers = choices.slice(0, 4);
  const digest = crypto.createHash('sha256').update(id).digest();
  for (let i = 3; i > 0; i--) { const j = digest[i] % (i + 1); [answers[i], answers[j]] = [answers[j], answers[i]]; }
  return { id, level, text, answers, correct: answers.indexOf(correctText), explanation, ...extras };
}
function numbers(value, step = 1) { return [value + step, value + step * 2, value - step, value + step * 3].filter(v => v >= 0 && v !== value); }
module.exports = { question, numbers };
