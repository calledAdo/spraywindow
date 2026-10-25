-- Removes everything register_zetaris_sources.sql creates for Spray Window. Run
-- teardown_zetaris_principals.sql first. SchemaStore views and their container have no SQL
-- drop in this Zetaris build; remove weather_views.forecast in Data Explorer if needed.
DROP DATASOURCE farm;
DROP LIGHTNING DATABASE TABLE products.label_rules;
DROP LIGHTNING DATABASE products;
DROP LIGHTNING DATABASE TABLE weather.forecast_raw;
DROP LIGHTNING DATABASE weather;
DROP LIGHTNING DATABASE TABLE weather_snap.forecast_snapshot;
DROP LIGHTNING DATABASE weather_snap;
