INSERT INTO event_series (id, team_id, season_id, title, kind, location, notes, time_zone, local_time, duration_minutes, frequency, by_weekday, start_date, until_date, status, created_at, updated_at) VALUES
  ('event_series_seed_falcons_practice', 'team_seed_falcons', 'season_seed_falcons', 'Practice', 'practice', 'Riverside Park, Field 2', 'Bring a glove and a full water bottle.', 'America/Phoenix', '17:30', 90, 'weekly', '["tuesday","thursday"]', date('now', '-7 hours'), date('now', '-7 hours', '+20 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('event_series_seed_falcons_hawks', 'team_seed_falcons', 'season_seed_falcons', 'Game vs. Scenario Hawks (home)', 'game', 'Riverside Park, Field 1', NULL, 'America/Phoenix', '10:00', 90, 'once', NULL, date('now', '-7 hours', '+1 day', 'weekday 6'), NULL, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('event_series_seed_falcons_owls', 'team_seed_falcons', 'season_seed_falcons', 'Game at Scenario Owls (away)', 'game', 'Owl Creek Fields, Diamond 3', NULL, 'America/Phoenix', '10:00', 90, 'once', NULL, date('now', '-7 hours', '+1 day', 'weekday 6', '+7 days'), NULL, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('event_series_seed_falcons_rays', 'team_seed_falcons', 'season_seed_falcons', 'Game vs. Scenario Rays (home)', 'game', 'Riverside Park, Field 1', NULL, 'America/Phoenix', '10:00', 90, 'once', NULL, date('now', '-7 hours', '+1 day', 'weekday 6', '+14 days'), NULL, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('event_series_seed_comets_clinic', 'team_seed_comets', 'season_seed_comets', 'Sunday skills clinic', 'practice', 'Comet Field', NULL, 'America/Phoenix', '09:00', 60, 'once', NULL, date('now', '-7 hours', '+1 day', 'weekday 0'), NULL, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO event_occurrences (id, series_id, team_id, local_date, starts_at_utc, duration_minutes, status, cancelled_reason, cancelled_at, created_at, updated_at)
WITH RECURSIVE offsets(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM offsets WHERE n < 20
),
days(local_date) AS (
  SELECT date('now', '-7 hours', '+' || n || ' days') FROM offsets
)
SELECT
  'event_occurrence_seed_falcons_practice_' || local_date,
  'event_series_seed_falcons_practice',
  'team_seed_falcons',
  local_date,
  strftime('%Y-%m-%dT%H:%M:%fZ', local_date || ' 17:30', '+7 hours'),
  90,
  'scheduled',
  NULL,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM days
WHERE strftime('%w', local_date) IN ('2', '4');

INSERT INTO event_occurrences (id, series_id, team_id, local_date, starts_at_utc, duration_minutes, status, cancelled_reason, cancelled_at, created_at, updated_at)
SELECT
  replace(series.id, 'event_series_', 'event_occurrence_'),
  series.id,
  series.team_id,
  series.start_date,
  strftime('%Y-%m-%dT%H:%M:%fZ', series.start_date || ' ' || series.local_time, '+7 hours'),
  series.duration_minutes,
  CASE series.id WHEN 'event_series_seed_falcons_rays' THEN 'cancelled' ELSE 'scheduled' END,
  CASE series.id WHEN 'event_series_seed_falcons_rays' THEN 'Field closed after heavy rain' END,
  CASE series.id WHEN 'event_series_seed_falcons_rays' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM event_series AS series
WHERE series.frequency = 'once' AND series.id LIKE 'event_series_seed_%';
