# Intelligence Briefing

## What this tool does

The Intelligence Briefing tool turns newsletter emails into a curated briefing.

It works in three stages:

1. **Import and extraction:** newsletter emails are identified and broken into individual topics.
2. **Curation:** you choose which extracted topics are eligible for a briefing.
3. **Generation:** you choose a format and date range, then the AI writes the briefing from the eligible topics received during that period.

The page is at:

`https://dchat.mclellan.scot/newsletter`

## The important distinction: emails, topics, and briefings

These are three different things:

- A **source email** is the original newsletter in Gmail or AgentMail.
- A **topic** is one story or item extracted from that email. A single newsletter can produce several topics.
- A **briefing** is a new document written from the selected topics that fall inside your chosen date range.

The AI does not write the briefing directly from every email in your inbox. It writes from the extracted topic records shown on the Intelligence page.

## How topics arrive

Topics can arrive in two ways:

- **Automatically:** Gmail and AgentMail processing identify newsletters and extract topics as messages arrive.
- **Import from Gmail:** use this when older newsletters have not yet been processed.

Each topic records:

- Headline
- Short summary
- Source name
- Category
- Newsletter receipt date
- Whether it is selected

The receipt date is what the briefing date range uses.

## Week selector versus briefing date range

The **Week** selector and the **From/To** fields have different jobs.

### Week selector

The Week selector controls which topics are displayed on the page for review. It helps you curate a manageable group of topics.

Changing the displayed week does not by itself define the final briefing period.

### From and To dates

The From and To fields control which selected topics are supplied to the briefing generator.

For example:

- Displayed week: `2026-W23`
- From: `1 June 2026`
- To: `14 June 2026`

The briefing can use selected topics received from 1–14 June, including topics from two displayed weeks.

When you select a week, the date range initially defaults to that week’s Monday through Sunday. You can change either date before generating.

## What “selected” means

A selected topic is eligible for inclusion. A deselected topic is excluded.

The generator applies both rules:

1. The topic must be selected.
2. Its newsletter receipt date must fall inside the From/To range.

Selecting a topic does not guarantee that the AI will give it equal space. The chosen format controls how the material is prioritised and written.

### Select all and Deselect all

These buttons affect the currently displayed week only.

Use them to quickly prepare a week, then adjust individual topics. If your briefing range spans several weeks, review and curate each relevant week before generating.

## Formats

A format is a reusable set of writing instructions. It controls the style and structure of the output, not the source period.

A format can define:

- Purpose and audience
- Structure
- Tone
- Target word count
- Maximum model output
- AI model

Every format uses the same From and To date controls shown in the Generate Briefing section.

Choose the format that matches the document you want. For example, a concise executive briefing should use different instructions from a detailed research digest.

## Recommended workflow

### 1. Confirm topics exist

Open the Intelligence page and choose the week you want to review.

If no topics appear:

- Wait for automatic processing if the emails are new.
- Use **Import from Gmail** for older material.
- Confirm the correct Gmail labels and source settings are configured.

### 2. Curate each relevant week

Review the extracted topics.

- Keep useful topics selected.
- Deselect promotional, repetitive, weak, or irrelevant items.
- If the intended date range spans multiple weeks, repeat this review for each week.

### 3. Choose a format

In **Generate briefing**, select the writing format that suits the intended reader and purpose.

### 4. Set the date range

Choose the inclusive From and To dates.

The range refers to when the source newsletter was received. Both boundary dates are included.

### 5. Generate

Select **Generate**.

The Hub:

1. Finds all selected topics in the date range.
2. Groups them by category.
3. Sends those topics and the format instructions to the configured briefing model.
4. Saves the resulting briefing.
5. Shows a preview.

If the page reports “No selected topics fall within this date range,” check the displayed weeks, topic selection, and chosen dates.

### 6. Review the preview

Check:

- Factual accuracy
- Missing important topics
- Repetition
- Tone and level of detail
- Whether the chosen format was appropriate

Generation creates a saved briefing, but it does not automatically make it public.

### 7. Choose an output action

- **Send to email:** emails the saved briefing to the configured recipient.
- **PDF:** downloads a formatted PDF.
- **Wiki:** creates a durable wiki page for internal knowledge and search.
- **Publish:** makes the briefing available through the public Douglas portfolio feed and `llms.txt`.
- **Delete:** removes the saved briefing from the Hub.

Publishing is the only action in this list that deliberately exposes the briefing through public portfolio channels.

## Recent briefings

Recent briefing cards show:

- The date range used
- Number of topics
- Format
- Whether it was sent
- Wiki and publication state

Older briefings created before date ranges were introduced retain their original week label.

## Import from Gmail

Use Import from Gmail to process newsletter emails that were not previously extracted.

1. Enter one or more Gmail labels.
2. Set **Days back**.
3. Select **Import**.

This import range controls which Gmail messages are fetched. It is separate from the briefing From/To range.

Importing does not immediately generate a briefing. It creates topics for you to review and select first.

## Interests and source settings

Interests define the available topic categories and their default selection behaviour.

Source settings can control:

- Gmail label
- Extraction mode
- Custom extraction instructions
- Body length supplied to extraction
- Extraction token limit

Extraction modes include:

- **Selective:** extracts each meaningful newsletter story and ignores promotional clutter.
- **Full:** captures nearly everything, useful for work-oriented sources.
- **Minimal:** keeps only the most significant one or two items.
- **Skip:** does not extract that source.

Auto-include means newly extracted topics in that category start selected. You can still deselect them manually.

## Example: produce a two-week executive briefing

1. Open week 23 and curate its topics.
2. Open week 24 and curate its topics.
3. In Generate Briefing, choose the executive format.
4. Set From to `1 June 2026`.
5. Set To to `14 June 2026`.
6. Select Generate.
7. Review the preview.
8. Send, export to the wiki, download the PDF, or publish as required.

## Troubleshooting

### No topics are shown

- Check the selected week.
- Import the relevant Gmail labels.
- Confirm newsletter processing is running.
- Review source extraction mode; it may be set to Skip.

### Expected topic is missing from the briefing

- Confirm the topic is selected.
- Confirm its source newsletter receipt date is inside the From/To range.
- Check the other relevant displayed week.
- Confirm the AI format did not intentionally prioritise or compress it.

### Too many irrelevant topics

- Deselect them before generation.
- Change the source extraction mode or instructions.
- Disable auto-include for categories that require manual review.

### Briefing is too long or too short

- Adjust the format’s target word count.
- Refine the format instructions.
- Narrow or widen the date range.
- Select or deselect topics.

### Briefing used material from another displayed week

This is expected when its selected topic falls inside the From/To range. The week selector controls the review display; the date range controls generation.

### Google Doc export

The Intelligence page currently offers email, PDF, Wiki, and Publish actions. This guide itself has been exported to Google Docs using the Hub’s existing Google Docs export service.
