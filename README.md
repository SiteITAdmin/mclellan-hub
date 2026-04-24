# McLellan Hub

## Overview

McLellan Hub is a self-hosted personal AI workspace and portfolio platform built for **Douglas McLellan** and **Nakai McLellan**.

The project was designed and directed through AI-assisted development. It is not presented as a polished SaaS product; it is a practical personal system for exploring private chat workflows, model routing, project memory, source-linked research, portfolio content, and lightweight VPS operations.

The app is a Node.js/Express + EJS application using SQLite for persistence. It routes by subdomain to serve private chat spaces, public portfolio sites, and admin tools.

## Features

- Multi-model private chat with OpenRouter, Google AI image models, and custom OpenAI-compatible providers.
- Project memory with uploaded documents, conversation history, and recall search.
- Source-linked research answers with clickable inline citations.
- Google Workspace OAuth for private hub and admin access.
- Portfolio pages with an AI chat drawer and CV/profile admin tools.
- Export of assistant answers to Word, PDF, and Google Docs.
- SQLite-backed request logs, ratings, model settings, sessions, and project data.
- VPS deployment scripts for a small self-hosted production setup.

## Security Model

Private chat and admin areas use Google Workspace OAuth. Runtime secrets live outside git in `.env`, and production data stays out of the repository.

## Products

### 1. McLellan Hub (Chat App)
**URLs:** `dchat.mclellan.scot` (Douglas), `nchat.mclellan.scot` (Nakai)

A private, multi-model AI chat interface with sidebar navigation, Projects + Recent Conversations, a multi-model picker (DeepSeek, Claude, Mistral, Grok, image models), data sovereignty toggle, message export (Word / PDF / Google Doc), per-user model settings, and mobile-responsive layout.

**Visual identity:** Dark UI — near-black backgrounds, violet-purple accent (#7c6af5), Inter + JetBrains Mono.

### 2. Portfolio Sites
**URLs:** `douglas.mclellan.scot`, `nakai.mclellan.scot`

Personal portfolio / résumé sites with hero, experience timeline, skills matrix, AI-powered JD fit checker, and chat drawer.

Two design generations:
- **v1 (production):** Simple light Inter design (`portfolio.css`)
- **v2 "Intellectual Quietude" (Stitch):** Noto Serif + Manrope, Material Design 3 color system, glassmorphism nav — the direction the portfolio is heading

### 3. Admin Panel
Model management + CV data. Same dark theme as the Hub.

---

## CONTENT FUNDAMENTALS

- **Voice:** First-person, professional, direct. "I operate as a pragmatic business partner."
- **Tone:** Authoritative and calm. Never salesy. Scholarly.
- **Casing:** Title case for section headers, sentence case for body.
- **Emoji:** None used anywhere.
- **Numbers:** Numerics for years/dates, spelled out for qualitative quantities.
- **Credentials:** Shown as chips — FCCA CIA CAMS MSc.
- **Model keys:** Short lowercase codes (claude-sonnet, deepseek-v3).

---

## VISUAL FOUNDATIONS

### Color System
Two palettes — one per surface:

**Hub (dark):**
- Background `#0f0f11`, Surface `#1a1a1f`, Surface2 `#242429`, Border `#2e2e36`
- Accent violet `#7c6af5`, dim `#4a3fa0`
- Text `#e8e8ec`, dim `#888`, Error `#e05252`, Success `#4caf8a`

**Portfolio v2 "Intellectual Quietude" (light):**
- Background `#fcf8ff`, Surface `#fff`
- Primary `#4648d4`, Primary Fixed `#e1e0ff`
- Surfaces: low `#f5f2fe`, container `#efecf8`, high `#e9e6f3`
- On-surface `#1b1b23`, variant `#464554`
- Outline `#767586`, outline-variant `#c7c4d7`
- Tertiary amber `#904900`

### Typography
- **Hub:** Inter (400/600/700) + JetBrains Mono. Sizes 11–24px. Tight density.
- **Portfolio v2:** Noto Serif display (h1–h3, 24–48px) + Manrope body/UI (12–18px).
- Both available via Google Fonts CDN.

### Spacing
Base 4px: xs=8, sm=16, md=24, lg=48, xl=80, gutter=24, margin=64.

### Corner Radii
Default 8px. sm=4px, md=12px, lg=16px, full=9999px (pills only).

### Animation
0.25s ease sidebars/drawers. 0.3s color transitions. active:scale-95 on primary CTAs only. No bounce.

### Elevation
Hub: surface layering only, no shadows. Portfolio: `shadow-xl` on hero portrait. Nav: `backdrop-filter: blur(20px)`. Cards: background shift, no border.

### Iconography
Portfolio v2 uses **Material Symbols Outlined** (Google Fonts CDN, variable font). Hub uses no icon library — plain text affordances (☰, ⚙).

---

## VISUAL FOUNDATIONS

### Backgrounds
Hub: flat dark, no gradients. Portfolio: flat white/near-white, section alternation via container-low tint. Glassmorphism only on fixed nav.

### Cards
Hub: 1px border + 8px radius, no shadow. Portfolio v2: background shift + 8px radius, no border in most cases.

### Imagery
Portfolio: professional portrait photography, large (~500px), subtle rotate-on-hover group effect. Hub: no imagery.

---

## FILES INDEX

```
README.md                          ← you are here
SKILL.md                           Agent skill definition
colors_and_type.css                CSS custom properties — both palettes + type scale

assets/                            Logos, icons, visual assets (typographic brand)

preview/                           Design System tab cards
  colors-hub.html                  Hub dark palette
  colors-portfolio.html            Portfolio Intellectual Quietude palette
  type-hub.html                    Inter + JetBrains Mono type scale
  type-portfolio.html              Noto Serif + Manrope type scale
  spacing.html                     Spacing scale + radii
  components-buttons.html          Button variants + chips
  components-inputs.html           Chat + portfolio input fields
  components-messages.html         Chat message bubbles + metadata
  components-sidebar.html          Hub sidebar navigation
  components-tags.html             Model/cost tags + credential pills

ui_kits/
  hub/
    index.html                     ← Interactive Hub prototype (login → chat → settings)
    Sidebar.jsx                    Sidebar + Login page components
    ChatArea.jsx                   Chat area + message bubble components
  portfolio/
    index.html                     ← Interactive Portfolio prototype (Nakai / Douglas toggle)
    Hero.jsx                       Nav + Hero section components
    Experience.jsx                 Timeline, skills matrix, chat drawer
```

### Google Fonts used
```
Inter:wght@400;500;600;700
JetBrains+Mono:wght@400;500
Noto+Serif:wght@400;500;600
Manrope:wght@400;500;600;700
Material+Symbols+Outlined (variable)
```
