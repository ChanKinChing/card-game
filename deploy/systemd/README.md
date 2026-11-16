# systemd — implementation slot

No unit installed. Future cardgame.service uses a non-login account that reads root-owned code/dependencies/static files and writes only runtime data. Plan sandbox directives, resource budgets, bounded shutdown/restart and external credentials; justify native/runtime exceptions.

The Node entry point now binds `http.host`, defaulting to `127.0.0.1` and overridable with `HOST`. A unit should leave `HOST` unset so the backend stays on loopback behind nginx. Record runtime/working directory, permissions, listeners, reboot/restart, logs and matching-version recovery. systemd-analyze security is supporting evidence rather than a standalone pass score. Budget collectors separately.
