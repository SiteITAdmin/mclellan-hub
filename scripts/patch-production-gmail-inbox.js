'use strict';

const fs = require('fs');

const file = '/app/lib/gmail.js';
const before = fs.readFileSync(file, 'utf8');
const oldBlock = `// Apply a label and remove from INBOX (archive)
async function moveToLabel(gmail, user, messageId, labelName) {
  const labelId = await getOrCreateLabel(gmail, user, labelName);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: ['INBOX'],
    },
  });
  console.log(\`[gmail] moved message \${messageId} → "\${labelName}"\`);
}`;
const newBlock = `// Apply a label but leave new mail in INBOX for the user to review.
async function moveToLabel(gmail, user, messageId, labelName) {
  const labelId = await getOrCreateLabel(gmail, user, labelName);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
    },
  });
  console.log(\`[gmail] labelled message \${messageId} → "\${labelName}"\`);
}`;

if (!before.includes(oldBlock)) {
  if (before.includes('leave new mail in INBOX')) {
    console.log('Already patched');
    process.exit(0);
  }
  throw new Error('Expected production Gmail block was not found');
}

fs.copyFileSync(file, `${file}.before-inbox-fix`);
fs.writeFileSync(file, before.replace(oldBlock, newBlock));
console.log('Patched production Gmail labeling to retain INBOX');
