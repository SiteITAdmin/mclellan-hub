#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workdayDir = process.env.WORKDAY_INDEX_SOURCE_DIR ||
  path.join(root, 'data', 'synthadoc', 'mclellan-hub-knowledge', 'raw_sources', 'workday');
const dailyDir = process.env.WORKDAY_INDEX_DAILY_DIR ||
  path.join(root, 'data', 'synthadoc', 'mclellan-hub-knowledge', 'Daily');

function readFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => path.join(dir, name));
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

function section(text, heading) {
  const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|(?![\\s\\S]))`, 'm');
  const match = text.match(re);
  return match ? match[1].trim() : '';
}

function listItems(block) {
  if (!block || /^none captured\.?$/i.test(block.trim())) return [];
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.replace(/^- /, '').trim())
    .filter(Boolean);
}

function noteLink(file) {
  return path.basename(file, '.md');
}

function noteDate(file, text) {
  const captured = frontmatterValue(text, 'captured_at');
  if (captured) return captured.slice(0, 10);
  const fromName = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/);
  return fromName ? fromName[1] : new Date().toISOString().slice(0, 10);
}

function noteTime(text) {
  const captured = frontmatterValue(text, 'captured_at');
  if (!captured) return '';
  const d = new Date(captured);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Dublin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const byDate = new Map();
for (const file of readFiles(workdayDir)) {
  const text = fs.readFileSync(file, 'utf8');
  const date = noteDate(file, text);
  const entry = {
    file,
    link: noteLink(file),
    time: noteTime(text),
    followUps: listItems(section(text, 'Actions')),
    people: listItems(section(text, 'People')),
    projects: listItems(section(text, 'Projects')),
  };
  if (!byDate.has(date)) byDate.set(date, []);
  byDate.get(date).push(entry);
}

fs.mkdirSync(dailyDir, { recursive: true });

for (const [date, entries] of [...byDate.entries()].sort()) {
  const followUps = unique(entries.flatMap(e => e.followUps));
  const people = unique(entries.flatMap(e => e.people));
  const projects = unique(entries.flatMap(e => e.projects));

  const lines = [
    '---',
    'type: "daily-workday-index"',
    `date: "${date}"`,
    'tags:',
    '  - workday',
    '  - daily-index',
    '---',
    '',
    `# ${date}`,
    '',
    '## Workday Debriefs',
    ...entries.map(e => `- ${e.time ? e.time + ' ' : ''}[[${e.link}]]`),
    '',
    '## Follow-ups',
    ...(followUps.length ? followUps.map(item => `- ${item}`) : ['- None captured.']),
    '',
    '## People',
    ...(people.length ? people.map(item => `- [[${item}]]`) : ['- None captured.']),
    '',
    '## Projects',
    ...(projects.length ? projects.map(item => `- [[${item}]]`) : ['- None captured.']),
    '',
  ];

  fs.writeFileSync(path.join(dailyDir, `${date}.md`), lines.join('\n'), 'utf8');
}

console.log(`Built ${byDate.size} daily workday index note(s).`);
