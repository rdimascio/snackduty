INSERT INTO duty_slots (id, team_id, occurrence_id, label, instructions, assignee_person_id, assigned_by_person_id, assigned_at, created_by_person_id, created_at, updated_at) VALUES
  ('duty_slot_seed_hawks_snacks', 'team_seed_falcons', 'event_occurrence_seed_falcons_hawks', 'Snacks', 'Orange slices and water for 12 players.', 'person_seed_parent', 'person_seed_parent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('duty_slot_seed_hawks_scorebook', 'team_seed_falcons', 'event_occurrence_seed_falcons_hawks', 'Scorebook', NULL, 'person_seed_co_coach', 'person_seed_co_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('duty_slot_seed_hawks_field_setup', 'team_seed_falcons', 'event_occurrence_seed_falcons_hawks', 'Field setup', 'Bases and chalk by 9:30.', NULL, NULL, NULL, 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('duty_slot_seed_owls_snacks', 'team_seed_falcons', 'event_occurrence_seed_falcons_owls', 'Snacks', 'Orange slices and water for 12 players.', 'person_seed_team_member', 'person_seed_team_member', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('duty_slot_seed_owls_scorebook', 'team_seed_falcons', 'event_occurrence_seed_falcons_owls', 'Scorebook', NULL, NULL, NULL, NULL, 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('duty_slot_seed_owls_field_setup', 'team_seed_falcons', 'event_occurrence_seed_falcons_owls', 'Field setup', 'Bases and chalk by 9:30.', 'person_seed_head_coach', 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'person_seed_head_coach', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('duty_slot_seed_comets_clinic_snacks', 'team_seed_comets', 'event_occurrence_seed_comets_clinic', 'Snacks', NULL, NULL, NULL, NULL, 'person_dev_adult', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO duty_slots (id, team_id, occurrence_id, label, instructions, assignee_person_id, assigned_by_person_id, assigned_at, created_by_person_id, created_at, updated_at)
WITH upcoming(position, occurrence_id) AS (
  SELECT row_number() OVER (ORDER BY local_date), id
  FROM event_occurrences
  WHERE series_id = 'event_series_seed_falcons_practice' AND local_date > date('now', '-7 hours')
),
claims(position, assignee_person_id) AS (
  VALUES (1, 'person_seed_parent'), (2, 'person_seed_team_member'), (3, NULL)
)
SELECT
  'duty_slot_seed_practice_snacks_' || upcoming.position,
  'team_seed_falcons',
  upcoming.occurrence_id,
  'Snacks',
  NULL,
  claims.assignee_person_id,
  claims.assignee_person_id,
  CASE WHEN claims.assignee_person_id IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END,
  'person_seed_head_coach',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM upcoming
JOIN claims ON claims.position = upcoming.position;
