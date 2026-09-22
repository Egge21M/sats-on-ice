# Activate one username and infer the domain at runtime

Each identity pairs a username with a destination reference; one persisted selection supplies the active identity and fallback values when identity environment variables are omitted. Only that active username is served, with new payouts using its destination; historical identities do not expose additional routes or isolate balances. The HTTPS reverse proxy preserves `Host`, from which the application derives the Lightning Address domain and HTTPS callback URLs, so no public domain is stored.
