---
"matrix-nodejs-homeserver": patch
---

The Postgres adapter prepares statements once per connection and reuses them, instead of having Postgres parse and plan every query again. Lists are now sent as one array parameter (`= ANY($1)`) and limits as parameters. If you use a connection pooler that does not support prepared statements, pass `postgresAdapter(pool, { preparedStatements: false })`. The SQLite adapter's statement cache is now bounded to 500 statements ([#40](https://github.com/k18k/matrix-nodejs-homeserver/issues/40)).

Breaking: `PgPoolLike.query` is now called with a config object (`{ text, values, name }`), as `pg.Pool` and `pg.Client` accept. A custom object that only takes `(text, values)` needs updating.
