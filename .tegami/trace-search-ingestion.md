---
packages:
  "@aryasaatvik/motel": patch
---

## Keep trace ingestion fast as history grows

Use indexed row mappings to replace span operation search entries without scanning retained history. Existing databases repair their mappings before enabling this path, and failed search-index updates roll back atomically.
