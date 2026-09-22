# Overture speed enrichment

This is a dry-run-first tool for filling missing speed limits in `road_edges` from Overture transportation data.

- Only currently unknown edges are considered.
- Only explicit, unconditional speed rules are used.
- No speed is inferred from road class.
- Existing speed data is never overwritten.
- Unknown roads remain routable.
- `--apply` is required before database changes.

Install:
```bash
python3 -m pip install -r scripts/requirements-overture.txt
```

Set `SUPABASE_DB_URL` to the CanWeDrive Postgres connection string, then run:
```bash
python3 scripts/enrich-road-speeds-overture.py
```

Review the match count. To apply:
```bash
python3 scripts/enrich-road-speeds-overture.py --apply
```

The first pass intentionally skips conditional, vehicle-specific, directional, and geometrically scoped Overture speed rules.