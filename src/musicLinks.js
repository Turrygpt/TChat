function extractMusicLinks(text = '') {
  const urlMatches = String(text).match(/https?:\/\/[^\s<>"']+/gi) || [];
  const musicDomains = /(youtube\.com|youtu\.be|rutube\.ru|vk\.com\/video|vkvideo\.ru\/video|vk\.com\/clip|vkvideo\.ru\/clip)/i;
  return urlMatches.filter((url) => musicDomains.test(url));
}

module.exports = { extractMusicLinks };
