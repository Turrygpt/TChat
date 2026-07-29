'use strict';

// Принимаем только осознанную команду победителя. Обычная фраза в чате не
// должна случайно стать игровым ником.
function parseNicknameCommand(text = '') {
  const match = String(text).match(/^\s*ник(?:\s*:\s*|\s+)(.+?)\s*$/iu);
  if (!match) return '';

  let nickname = match[1].replace(/\s+/g, ' ').trim();
  if (nickname.startsWith('[') && nickname.endsWith(']')) {
    nickname = nickname.slice(1, -1).trim();
  }
  if (!nickname || nickname.length > 120 || /[\r\n]/.test(nickname)) return '';
  return nickname;
}

module.exports = { parseNicknameCommand };
