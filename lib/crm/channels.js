'use strict';

// Which project a whole channel belongs to, when Douglas has said so: e.g.
// the WDS mailbox and the "WDS Board 2026" WhatsApp group both feed Wicklow
// Dementia Support. The reader is told, and still decides fact by fact, so a
// stray personal message in that chat doesn't land in the project.

const { crm, now, setting, setSetting } = require('./db');

// A mailbox is one channel; each WhatsApp chat is its own channel.
function channelOf(source) {
  if (!source) return '';
  if (source.origin === 'whatsapp') return `whatsapp:${source.raw_ref}`;
  return source.origin;
}

function projectForChannel(channel) {
  if (!channel) return null;
  return crm().prepare(`
    SELECT p.* FROM channel_projects c JOIN projects p ON p.id = c.project_id WHERE c.channel = ?
  `).get(channel) || null;
}

function projectFor(source) {
  const p = projectForChannel(channelOf(source));
  return p && p.space === source.space ? p : null;
}

function setProject(channel, projectId) {
  if (!projectId) {
    crm().prepare('DELETE FROM channel_projects WHERE channel = ?').run(channel);
    return null;
  }
  if (!crm().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('Project not found');
  crm().prepare(`INSERT INTO channel_projects (channel, project_id, set_at) VALUES (?, ?, ?)
                 ON CONFLICT(channel) DO UPDATE SET project_id = excluded.project_id, set_at = excluded.set_at`)
    .run(channel, projectId, now());
  return projectForChannel(channel);
}

// Once only, so a later change Douglas makes to the mailbox's project stands.
function seedOnce() {
  if (setting('wds_channel_done')) return null;
  const { wdsProject } = require('./config');
  const project = require('./review').createProject(wdsProject.space, wdsProject.name);
  setProject('gmail:douglas@wicklowdementiasupport.ie', project.id);
  setSetting('wds_channel_done', String(now()));
  return project;
}

module.exports = { channelOf, projectFor, projectForChannel, setProject, seedOnce };
