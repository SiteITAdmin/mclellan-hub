# Hub function review — October 2026

Started 24 Oct 2026 while the Hub is paused (only flight jobs run since 13 Oct).
One decision per function. Nothing is implemented until the review is complete,
unless Douglas says otherwise.

| # | Function | Decision | Notes |
|---|----------|----------|-------|
| 1 | Gmail email processing | Keep, changed | Stop writing Hub labels to Gmail (`moveToLabel`) and stop label-correction learning. Keep Ryanair booking → flights and Skyscanner price alerts → `travel_price_points`. Open: does other mail still feed CRM/tasks read-only? |
| 2 | AgentMail inbox (`mclellanhub@agentmail.to`) | Keep | As is. Outbound AgentMail sending is unaffected either way. |
