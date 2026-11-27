import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const profile = process.argv[2] || (process.env.APPDATA && path.join(process.env.APPDATA, 'tchat'));
if (!profile) throw new Error('Pass the path to the TChat userData directory.');

function readSettings(name) {
  return JSON.parse(fs.readFileSync(path.join(profile, 'settings', name), 'utf8').replace(/^\uFEFF/, ''));
}

const settings = readSettings('alert-rules.json');
const scene = readSettings('stream-widgets.json');
const { clientId } = readSettings('donationalerts.json');
if (!/^\d+$/.test(String(clientId || ''))) throw new Error('The TChat profile has no DonationAlerts client ID.');
if (!Array.isArray(settings.rules)) throw new Error('The TChat profile has no donation rules.');

const output = path.join(project, 'android', 'app', 'build', 'personalDonationAssets', 'alerts');
const files = new Map();

function findLocalMedia(reference) {
  if (!reference) return null;
  const url = new URL(reference, 'http://localhost:3000');
  const relative = decodeURIComponent(url.pathname);
  const basename = path.basename(relative);
  if (relative !== `/assets/alerts/${basename}` && relative !== `/assets/alerts/defaults/${basename}`) {
    throw new Error(`The alert media is outside TChat's alert assets: ${basename}`);
  }
  const candidates = [profile, project].map(root => path.join(root, relative.slice(1)));
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function addFile(source) {
  const file = path.basename(source);
  const existing = files.get(file);
  if (existing && existing !== source) throw new Error(`Duplicate alert media name: ${file}`);
  files.set(file, source);
  return `media/${file}`;
}

const rules = settings.rules.filter(rule => rule.enabled !== false).map(rule => {
  const image = findLocalMedia(rule.image);
  const sound = findLocalMedia(rule.sound);
  if (rule.image && !image) throw new Error(`Missing image for alert «${rule.title}».`);
  if (rule.sound && !sound) throw new Error(`Missing sound for alert «${rule.title}».`);
  const video = image && /\.gif$/i.test(image) ? findLocalMedia(rule.image.replace(/\.gif(?=\?|$)/i, '.mp4')) : null;
  return {
    type: rule.type,
    nickname: rule.nickname,
    amount: rule.amount,
    min: rule.min,
    max: rule.max,
    image: image ? addFile(image) : '',
    video: video ? addFile(video) : '',
    sound: sound ? addFile(sound) : '',
    volume: rule.volume,
  };
});

const placement = (scene.items || []).find(widget => widget.type === 'alerts' || widget.id === 'builtin-alerts') || {};
const { width, height, scale } = placement;
const snapshot = {
  clientId: String(clientId),
  displaySeconds: settings.displaySeconds,
  layout: { width, height, scale },
  rules,
};

// This directory contains only generated files for the APK.
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'media'), { recursive: true });
for (const [file, source] of files) fs.copyFileSync(source, path.join(output, 'media', file));
fs.writeFileSync(path.join(output, 'profile.json'), JSON.stringify(snapshot, null, 2));
console.log(`Packaged ${rules.length} donation rules and ${files.size} media files from TChat.`);
