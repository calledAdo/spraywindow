-- Generated from src/data/policy.ts for Spray Window.
-- ADD USER WITH is supported by the local Lightning parser (not listed in the guide).
ADD USER WITH (name 'sw_rules_checker', email '${ZETARIS_RULES_CHECKER_USER}', password '${ZETARIS_RULES_CHECKER_PASSWORD}');
CREATE ROLE 'sw_rules_checker' DESCRIBE BY 'Spray Window rules checker read-only tables';
ASSIGN USER '${ZETARIS_RULES_CHECKER_USER}' TO ROLE 'sw_rules_checker';
GRANT SELECT ON DATASOURCE TABLE farm.blocks TO ROLE 'sw_rules_checker';
GRANT SELECT ON LIGHTNING DATABASE TABLE products.label_rules TO ROLE 'sw_rules_checker';
GRANT SELECT ON VIEW TABLE weather_views.forecast TO ROLE 'sw_rules_checker';
GRANT SELECT ON LIGHTNING DATABASE TABLE weather_snap.forecast_snapshot TO ROLE 'sw_rules_checker';

ADD USER WITH (name 'sw_weather_analyst', email '${ZETARIS_WEATHER_ANALYST_USER}', password '${ZETARIS_WEATHER_ANALYST_PASSWORD}');
CREATE ROLE 'sw_weather_analyst' DESCRIBE BY 'Spray Window weather analyst read-only tables';
ASSIGN USER '${ZETARIS_WEATHER_ANALYST_USER}' TO ROLE 'sw_weather_analyst';
GRANT SELECT ON VIEW TABLE weather_views.forecast TO ROLE 'sw_weather_analyst';
GRANT SELECT ON LIGHTNING DATABASE TABLE weather_snap.forecast_snapshot TO ROLE 'sw_weather_analyst';
GRANT SELECT ON DATASOURCE TABLE farm.blocks TO ROLE 'sw_weather_analyst';

ADD USER WITH (name 'sw_memory_keeper', email '${ZETARIS_MEMORY_KEEPER_USER}', password '${ZETARIS_MEMORY_KEEPER_PASSWORD}');
CREATE ROLE 'sw_memory_keeper' DESCRIBE BY 'Spray Window memory keeper read-only tables';
ASSIGN USER '${ZETARIS_MEMORY_KEEPER_USER}' TO ROLE 'sw_memory_keeper';
GRANT SELECT ON DATASOURCE TABLE farm.blocks TO ROLE 'sw_memory_keeper';
GRANT SELECT ON DATASOURCE TABLE farm.past_applications TO ROLE 'sw_memory_keeper';

ADD USER WITH (name 'sw_planner', email '${ZETARIS_PLANNER_USER}', password '${ZETARIS_PLANNER_PASSWORD}');
CREATE ROLE 'sw_planner' DESCRIBE BY 'Spray Window planner read-only tables';
ASSIGN USER '${ZETARIS_PLANNER_USER}' TO ROLE 'sw_planner';
GRANT SELECT ON DATASOURCE TABLE farm.blocks TO ROLE 'sw_planner';
GRANT SELECT ON DATASOURCE TABLE farm.crew TO ROLE 'sw_planner';
GRANT SELECT ON DATASOURCE TABLE farm.equipment TO ROLE 'sw_planner';
GRANT SELECT ON LIGHTNING DATABASE TABLE products.label_rules TO ROLE 'sw_planner';
GRANT SELECT ON VIEW TABLE weather_views.forecast TO ROLE 'sw_planner';
GRANT SELECT ON LIGHTNING DATABASE TABLE weather_snap.forecast_snapshot TO ROLE 'sw_planner';

ADD USER WITH (name 'sw_critic', email '${ZETARIS_CRITIC_USER}', password '${ZETARIS_CRITIC_PASSWORD}');
CREATE ROLE 'sw_critic' DESCRIBE BY 'Spray Window critic read-only tables';
ASSIGN USER '${ZETARIS_CRITIC_USER}' TO ROLE 'sw_critic';
GRANT SELECT ON DATASOURCE TABLE farm.blocks TO ROLE 'sw_critic';
GRANT SELECT ON DATASOURCE TABLE farm.crew TO ROLE 'sw_critic';
GRANT SELECT ON DATASOURCE TABLE farm.equipment TO ROLE 'sw_critic';
GRANT SELECT ON LIGHTNING DATABASE TABLE products.label_rules TO ROLE 'sw_critic';
GRANT SELECT ON VIEW TABLE weather_views.forecast TO ROLE 'sw_critic';
GRANT SELECT ON LIGHTNING DATABASE TABLE weather_snap.forecast_snapshot TO ROLE 'sw_critic';
GRANT SELECT ON DATASOURCE TABLE farm.past_applications TO ROLE 'sw_critic';