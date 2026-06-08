---
aliases: []
categories: []
confidence: high
created: '2026-05-08T17:02:18'
orphan: false
sources:
- file: /Users/dm_mini/Documents/mclellan hub/data/synthadoc/mclellan-hub-knowledge/raw_sources/mclellan-hub-readme.md
  hash: 004127cfadffc0e7d4131a08aadc8d97fe15e0dd8ec9e1de6cd9761d7c3ead24
  ingested: '2026-05-08T17:02:18'
  size: 6526
status: active
tags:
- personal AI workspace
- Node.js
- Express
- multi-model chat
- self-hosted
- VPS
- OAuth
- project memory
title: McLellan Hub Overview
---

# McLellan Hub Overview

McLellan Hub is a self-hosted personal AI workspace for Douglas and Nakai McLellan. It combines private multi-model chat, project memory, source-linked research, CRM features, knowledge tools, portfolio sites, and operational dashboards in one system.

## Core Platform

- **Application:** Node.js and Express
- **Persistence:** SQLite plus Markdown vault content
- **Authentication:** Google Workspace OAuth
- **AI routing:** OpenRouter and connected model providers
- **Hosting:** Hetzner VPS behind Nginx and Cloudflare
- **Domains:** Separate subdomains for chat, portfolios, administration, CRM, and the wiki

## Main Capabilities

- Private multi-model conversations in dchat and nchat
- Persistent project context and uploaded source documents
- CRM records and generated Markdown projections under `People/`
- Searchable wiki pages compiled from documents, conversations, and other sources
- Email organisation, summaries, and relationship context
- Operational tools including token usage and flight tracking
- Public portfolio sites for Douglas and Nakai

## Design Principle

The Hub links naturally occurring work to useful records. Its databases remain authoritative for structured application data, while Markdown projections make selected information searchable and readable in the wider knowledge system.

Source-specific material should live in dedicated pages rather than being appended here merely because it mentions AI, personal knowledge management, or the McLellan Hub.
