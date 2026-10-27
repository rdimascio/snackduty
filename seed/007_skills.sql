INSERT INTO skill_events (id, participant_id, event, occurred_at, created_at)
WITH RECURSIVE day_offsets(days_ago) AS (
  SELECT 0
  UNION ALL
  SELECT days_ago + 1 FROM day_offsets WHERE days_ago < 6
),
rotation(position, skill) AS (
  VALUES
    (0, 'infield.ready-position'),
    (1, 'baserunning.out-of-the-box'),
    (2, 'outfield.hit-the-cutoff'),
    (3, 'bunting.sacrifice'),
    (4, 'mental.failure'),
    (5, 'hitting.approach-by-count'),
    (6, 'pitching.pickoffs'),
    (7, 'infield.throw-on-the-run'),
    (8, 'baserunning.hook-slide')
),
players(participant_key, participant_id, player_id, drills_per_day, drill_days) AS (
  VALUES
    ('avery', 'participant_seed_avery', 'plr_participantseedavery', 2, 7),
    ('blake', 'participant_seed_blake', 'plr_participantseedblake', 1, 3)
),
slots(slot) AS (
  VALUES (0), (1)
),
drills(id, participant_id, player_id, type, skill, source, occurred_at) AS (
  SELECT
    'evt_seed' || players.participant_key || 'd' || day_offsets.days_ago || 'n' || slots.slot,
    players.participant_id,
    players.player_id,
    'drill_completed',
    rotation.skill,
    json_object('kind', 'drill', 'id', 'scenario/' || replace(rotation.skill, '.', '-')),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || day_offsets.days_ago || ' days', '-' || (slots.slot + 1) || ' seconds')
  FROM players
  JOIN day_offsets ON day_offsets.days_ago < players.drill_days
  JOIN slots ON slots.slot < players.drills_per_day
  JOIN rotation ON rotation.position = ((6 - day_offsets.days_ago) * players.drills_per_day + slots.slot) % 9
  UNION ALL
  SELECT
    'evt_seedaverymodule',
    'participant_seed_avery',
    'plr_participantseedavery',
    'module_completed',
    'infield.cutoff-lead',
    json_object('kind', 'module', 'id', 'cutoffs-and-relays', 'version', 1),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days', '-10 seconds')
  UNION ALL
  SELECT
    'evt_seedaveryhighfive',
    'participant_seed_avery',
    'plr_participantseedavery',
    'high_five',
    'mental.failure',
    json_object('kind', 'teammate', 'id', 'scenario/great-hustle'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days', '-20 seconds')
)
SELECT
  id,
  participant_id,
  json_object(
    'contract', 'skill.events/v0',
    'id', id,
    'playerId', player_id,
    'occurredAt', occurred_at,
    'localDate', date(occurred_at, '-7 hours'),
    'app', 'snackday',
    'type', type,
    'skill', skill,
    'source', json(source)
  ),
  occurred_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM drills;
