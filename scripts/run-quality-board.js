#!/usr/bin/env node
'use strict';

const { runHubQualityBoards, writeLinkedInQualityReview } = require('../lib/hub-quality-board');

const user = process.argv[2] || 'douglas';
const postId = process.argv[3] || '';

if (postId) {
  const result = writeLinkedInQualityReview({ user, postId });
  console.log(JSON.stringify(result.receipt, null, 2));
} else {
  const result = runHubQualityBoards(user);
  console.log(JSON.stringify(result, null, 2));
}
